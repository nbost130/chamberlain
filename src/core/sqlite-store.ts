/**
 * The Store (store.ts) on bun:sqlite: one database file, `<cache>/chamberlain.db`.
 *
 * The file is opened in WAL mode with a busy timeout and foreign keys on, so the daemon and the page can both write to it
 * at once: a writer waits for the write lock instead of failing, readers never block, and a transaction (BEGIN
 * IMMEDIATE) takes the lock when it starts, so no two read-modify-write sequences interleave. `synchronous = FULL` makes
 * every commit durable before it returns, which is what the old fsynced ledgers promised.
 *
 * Schema changes are the versioned SQL migrations in migrations.ts, each applied once inside a transaction and
 * recorded in the `migrations` table. A database whose newest migration is newer than this build's is refused.
 *
 * This file is the only writer of the notification columns of `items`: everything else asks `ItemStore.observe`, which asks
 * `decideNotification`.
 */
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations } from "./apply-migrations.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { DIR_MODE, enforceMode, FILE_MODE } from "./private.ts";
import { SchemaTooNewError } from "./schema.ts";
import { makeClaims, makeEvidence, makeSequence, makeState } from "./sqlite-claims.ts";
import type { Db, Row } from "./sqlite-db.ts";
import { makeItems } from "./sqlite-items.ts";
import { makeDispositions, makeEvents, makeUsage } from "./sqlite-log.ts";
import { makeAway, makeButlers, makeDecisions, makeRulings } from "./sqlite-rulings.ts";
import { makeChallenges, makeWakes } from "./sqlite-wakes.ts";
import type { Store } from "./store.ts";

/** The database was written by a newer Chamberlain than this build. */
export class DatabaseTooNewError extends SchemaTooNewError {
	constructor(path: string, found: number) {
		super(`the database ${path}`, found, LATEST_MIGRATION, "migration");
		this.name = "DatabaseTooNewError";
	}
}

export type OpenOptions = {
	/** How long a writer waits for another process's write lock before giving up. Default 10 seconds. */
	busyMs?: number;
	/** How a mode is set (default fs.chmodSync). A seam for tests: whatever it does, the mode is read back and must be right. */
	chmod?: (path: string, mode: number) => void;
};

/** The directory 0700 and the file 0600, each CHECKED after the chmod, and the file created before SQLite makes its own -wal and -shm files. */
export function preparePrivateFile(path: string, o: OpenOptions): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	// Private before anything else: the directory 0700 and the file 0600, each CHECKED after the chmod. A mode that cannot be set
	// (not our file, a filesystem without modes) is a refusal to start, never a database anyone else can read. The file exists and is 0600
	// before SQLite makes its own -wal and -shm files, which copy the main file's mode.
	enforceMode(dir, DIR_MODE, "the state directory", o.chmod);
	closeSync(openSync(path, "a", FILE_MODE));
	enforceMode(path, FILE_MODE, "the database", o.chmod);
}

/** The database at `path` (or `:memory:`), private, with its pragmas set and every migration applied. */
function openDatabase(path: string, o: OpenOptions): Database {
	const memory = path === ":memory:";
	if (!memory) preparePrivateFile(path, o);
	const db = new Database(path, { create: true });
	// The timeout first: switching to WAL takes a lock another process may hold.
	db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(o.busyMs ?? 10_000))}`);
	if (!memory) db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = FULL");
	try {
		migrate(db, path);
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

// ---- transactions -------------------------------------------------------------------------------

/**
 * A transaction wrapper over `db`: BEGIN IMMEDIATE at the top level and a savepoint inside one. A callback that returns a promise is refused.
 * `after(fn)` runs `fn` once the outermost transaction has committed (at once when none is open), and never when it rolls back: the telemetry
 * of a ledger write waits for the write to be real.
 */
function makeTx(db: Database): { tx: Db["tx"]; after: (fn: () => void) => void } {
	let depth = 0;
	let later: (() => void)[] = [];
	function ran(fns: (() => void)[]) {
		for (const fn of fns) {
			try {
				fn();
			} catch {
				/* a telemetry callback never fails a commit */
			}
		}
	}
	function outermost<T>(fn: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		depth = 1;
		try {
			const out = fn();
			if (out && typeof (out as { then?: unknown }).then === "function")
				throw Error("a store transaction cannot await");
			db.exec("COMMIT");
			const done = later;
			later = [];
			depth = 0;
			ran(done);
			return out;
		} catch (e) {
			later = [];
			try {
				db.exec("ROLLBACK");
			} catch {
				/* the transaction already ended */
			}
			throw e;
		} finally {
			depth = 0;
		}
	}
	function nested<T>(fn: () => T): T {
		const name = `sp${depth}`;
		const mark = later.length;
		db.exec(`SAVEPOINT ${name}`);
		depth++;
		try {
			const out = fn();
			db.exec(`RELEASE ${name}`);
			return out;
		} catch (e) {
			later.length = mark;
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw e;
		} finally {
			depth--;
		}
	}
	return {
		tx: <T>(fn: () => T): T => (depth === 0 ? outermost(fn) : nested(fn)),
		after: (fn) => (depth === 0 ? ran([fn]) : later.push(fn)),
	};
}

/** Opens (creating and migrating) the database at `path`, or `:memory:`. */
export function openStore(path: string, o: OpenOptions = {}): Store {
	const db = openDatabase(path, o);
	const busyMs = Math.max(1, Math.floor(o.busyMs ?? 10_000));
	const { tx, after } = makeTx(db);
	const c: Db = {
		tx,
		all: (sql, ...p) => db.query(sql).all(...(p as never[])) as Row[],
		one: (sql, ...p) => (db.query(sql).get(...(p as never[])) ?? undefined) as Row | undefined,
		run: (sql, ...p) => db.query(sql).run(...(p as never[])),
		nowait: (fn) => {
			db.exec("PRAGMA busy_timeout = 0");
			try {
				return fn();
			} finally {
				db.exec(`PRAGMA busy_timeout = ${busyMs}`);
			}
		},
	};
	const closers: (() => void)[] = [];
	return {
		path,
		tx: c.tx,
		close: () => {
			for (const fn of closers.splice(0)) fn();
			db.close();
		},
		afterCommit: after,
		onClose: (fn) => {
			closers.push(fn);
		},
		items: makeItems(c),
		claims: makeClaims(c),
		evidence: makeEvidence(c),
		rulings: makeRulings(c),
		decisions: makeDecisions(c),
		butlers: makeButlers(c),
		away: makeAway(c),
		wakes: makeWakes(c),
		challenges: makeChallenges(c),
		events: makeEvents(c),
		state: makeState(c),
		sequence: makeSequence(c),
		usage: makeUsage(c),
		dispositions: makeDispositions(c),
	};
}

/**
 * Folds a database's write-ahead log into its main file (a TRUNCATE checkpoint) and closes it, so the one file can be moved
 * or copied whole. False when another process has the database open and the log could not be folded. Does not migrate.
 */
export function foldWal(path: string, busyMs = 5000): boolean {
	const db = new Database(path);
	try {
		db.exec(`PRAGMA busy_timeout = ${busyMs}`);
		const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
		return !r || r.busy === 0;
	} finally {
		db.close();
	}
}

function migrate(db: Database, path: string) {
	applyMigrations(db, MIGRATIONS, (found) => new DatabaseTooNewError(path, found));
}

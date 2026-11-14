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
function preparePrivateFile(path: string, o: OpenOptions): void {
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

/** A transaction wrapper over `db`: BEGIN IMMEDIATE at the top level and a savepoint inside one. A callback that returns a promise is refused. */
function makeTx(db: Database): Db["tx"] {
	let depth = 0;
	function outermost<T>(fn: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		depth = 1;
		try {
			const out = fn();
			if (out && typeof (out as { then?: unknown }).then === "function")
				throw Error("a store transaction cannot await");
			db.exec("COMMIT");
			return out;
		} catch (e) {
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
		db.exec(`SAVEPOINT ${name}`);
		depth++;
		try {
			const out = fn();
			db.exec(`RELEASE ${name}`);
			return out;
		} catch (e) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw e;
		} finally {
			depth--;
		}
	}
	return <T>(fn: () => T): T => (depth === 0 ? outermost(fn) : nested(fn));
}

/** Opens (creating and migrating) the database at `path`, or `:memory:`. */
export function openStore(path: string, o: OpenOptions = {}): Store {
	const db = openDatabase(path, o);
	const c: Db = {
		tx: makeTx(db),
		all: (sql, ...p) => db.query(sql).all(...(p as never[])) as Row[],
		one: (sql, ...p) => (db.query(sql).get(...(p as never[])) ?? undefined) as Row | undefined,
		run: (sql, ...p) => db.query(sql).run(...(p as never[])),
	};
	return {
		path,
		tx: c.tx,
		close: () => db.close(),
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
	db.exec(
		"CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const newest = () => (db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0;
	const found = newest();
	if (found > LATEST_MIGRATION) throw new DatabaseTooNewError(path, found);
	for (const m of MIGRATIONS) {
		if (m.version <= found) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			// Another process may have applied it while this one waited for the lock.
			if (m.version > newest()) {
				db.exec(m.sql);
				db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
					m.version,
					m.name,
					new Date().toISOString(),
				);
			}
			db.exec("COMMIT");
		} catch (e) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ended */
			}
			throw e;
		}
	}
}

/**
 * How a Chamberlain database file is opened: private, in WAL mode, with a busy timeout and foreign keys on, and with its versioned SQL
 * migrations applied, each once, inside one transaction, and recorded in the file's own `migrations` table. `chamberlain.db`
 * (src/core/sqlite-store.ts) and an optional module's own file (`mail.db`, src/modules/mail/db.ts) are opened by the same code, each with its
 * own list of migrations, so a module's tables are never created in `chamberlain.db` and an older daemon never refuses that file over a
 * module's change.
 *
 * A database whose newest recorded migration is newer than the last one in its list was written by a newer build: `Schema.tooNew`
 * says what to throw, and the file is refused before anything is read or written.
 */
import { type Changes, Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Migration } from "./migrations.ts";
import { DIR_MODE, enforceMode, FILE_MODE } from "./private.ts";

type Row = Record<string, unknown>;

export type OpenOptions = {
	/** How long a writer waits for another process's write lock before giving up. Default 10 seconds. */
	busyMs?: number;
	/** How a mode is set (default fs.chmodSync). A seam for tests: whatever it does, the mode is read back and must be right. */
	chmod?: (path: string, mode: number) => void;
};

/** One database and what every part of its store needs from it: the transaction wrapper and three query helpers. */
export type Db = {
	tx<T>(fn: () => T): T;
	all(sql: string, ...p: unknown[]): Row[];
	one(sql: string, ...p: unknown[]): Row | undefined;
	run(sql: string, ...p: unknown[]): Changes;
};

/** A database's migrations, and what to throw when the file has a newer one than the last of them. */
export type Schema = {
	migrations: readonly Migration[];
	tooNew(path: string, found: number): Error;
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

/** The database at `path` (or `:memory:`), private, with its pragmas set and every migration of `schema` applied. */
export function openDatabase(path: string, o: OpenOptions, schema: Schema): Database {
	const memory = path === ":memory:";
	if (!memory) preparePrivateFile(path, o);
	const db = new Database(path, { create: true });
	// The timeout first: switching to WAL takes a lock another process may hold.
	db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(o.busyMs ?? 10_000))}`);
	if (!memory) db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = FULL");
	try {
		migrate(db, path, schema);
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

/** The transaction wrapper and query helpers over `db`. */
export function queries(db: Database): Db {
	return {
		tx: makeTx(db),
		all: (sql, ...p) => db.query(sql).all(...(p as never[])) as Row[],
		one: (sql, ...p) => (db.query(sql).get(...(p as never[])) ?? undefined) as Row | undefined,
		run: (sql, ...p) => db.query(sql).run(...(p as never[])),
	};
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

// ---- migrations ---------------------------------------------------------------------------------

function migrate(db: Database, path: string, schema: Schema) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const newest = () => (db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0;
	const found = newest();
	const latest = schema.migrations[schema.migrations.length - 1]?.version ?? 0;
	if (found > latest) throw schema.tooNew(path, found);
	for (const m of schema.migrations) {
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

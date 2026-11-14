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
import { type OpenOptions, openDatabase, queries } from "./database.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { SchemaTooNewError } from "./schema.ts";
import { makeClaims, makeEvidence, makeSequence, makeState } from "./sqlite-claims.ts";
import { makeItems } from "./sqlite-items.ts";
import { makeDispositions, makeEvents, makeUsage } from "./sqlite-log.ts";
import { makeAway, makeButlers, makeDecisions, makeRulings } from "./sqlite-rulings.ts";
import { makeChallenges, makeWakes } from "./sqlite-wakes.ts";
import type { Store } from "./store.ts";

export type { OpenOptions };

/** The database was written by a newer Chamberlain than this build. */
export class DatabaseTooNewError extends SchemaTooNewError {
	constructor(path: string, found: number) {
		super(`the database ${path}`, found, LATEST_MIGRATION, "migration");
		this.name = "DatabaseTooNewError";
	}
}

/** Opens (creating and migrating) the database at `path`, or `:memory:`. */
export function openStore(path: string, o: OpenOptions = {}): Store {
	const db = openDatabase(path, o, { migrations: MIGRATIONS, tooNew: (p, found) => new DatabaseTooNewError(p, found) });
	const c = queries(db, o);
	const closers: (() => void)[] = [];
	return {
		path,
		tx: c.tx,
		close: () => {
			for (const fn of closers.splice(0)) fn();
			db.close();
		},
		afterCommit: c.after,
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

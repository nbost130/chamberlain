/**
 * `obs.db`: the telemetry database, beside `chamberlain.db` in the state directory (docs/OBSERVABILITY.md section 2). WAL, mode 0600, and its own
 * migrations: a metrics change never makes an older daemon refuse the ledger, and a backup of `chamberlain.db` does not grow with telemetry.
 *
 * Three rules make a log call cheap and safe: `synchronous = NORMAL` (a commit does not wait for a disk flush; a power cut can lose the last
 * moments of telemetry, never corrupt it), `busy_timeout = 0` (a writer that finds the lock held gives up at once, and the row waits in memory) and
 * `wal_autocheckpoint = 0` (SQLite's own checkpoint runs inside whichever INSERT crosses 1,000 pages and costs it several milliseconds of fsync:
 * measured, p99 3 ms against 0.09 ms without it). The daemon checkpoints from its hourly pass instead (`Obs.checkpoint`), and a closing connection does.
 */
import { Database } from "bun:sqlite";
import { applyMigrations } from "../apply-migrations.ts";
import { type OpenOptions, preparePrivateFile } from "../database.ts";
import type { Migration } from "../migrations.ts";
import { SchemaTooNewError } from "../schema.ts";

/** The telemetry database's handle, and the ledger's read-only one: the only types of the driver that leave this file. */
export type ObsDb = Database;
export type LedgerDb = Database;

/** The ledger opened read-only: the reconciler never writes `chamberlain.db`. */
export const openLedger = (path: string): LedgerDb => new Database(path, { readonly: true });

const OBS_FILE = "obs.db";
export const obsPath = (state: string) => `${state}/${OBS_FILE}`;

/** `obs.db` was written by a newer Chamberlain than this build. */
export class ObsTooNewError extends SchemaTooNewError {
	constructor(path: string, found: number) {
		super(`the telemetry database ${path}`, found, OBS_MIGRATIONS.at(-1)?.version ?? 0, "migration");
		this.name = "ObsTooNewError";
	}
}

/** Every telemetry migration is `obs.db`'s own (B2 to B8 add theirs here). A migration is never edited after a release. */
export const OBS_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "events and counters",
		sql: `
-- One row per thing that happened. Every column but \`data\` is an identifier or a digest, and \`data\` holds only the fields the registry
-- (src/core/obs/registry.ts) types. \`host\` is the machine that wrote it (the pull in B3 fills it for the others); \`corr\` is the 12-hex digest
-- that joins a wake, its digest, the Steward's turn and the question and answer; \`source_key\` is set on a row derived from a ledger row.
CREATE TABLE events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	t TEXT NOT NULL,
	level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
	host TEXT NOT NULL,
	run TEXT NOT NULL,
	mod TEXT NOT NULL,
	event TEXT NOT NULL,
	corr TEXT,
	delivery TEXT,
	thread TEXT,
	source_key TEXT UNIQUE,
	data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);
CREATE INDEX events_by_time ON events (t);
CREATE INDEX events_by_event ON events (event, t);
CREATE INDEX events_by_corr ON events (corr) WHERE corr IS NOT NULL;
CREATE INDEX events_by_thread ON events (thread, t) WHERE thread IS NOT NULL;

-- The logger's own counters, added to by every process that writes: log.rejected (an unknown event or field, dropped), log.redacted (the
-- scrubber caught something: must read zero), log.failed (a write that failed) and log.dropped (a row lost from a full buffer).
CREATE TABLE obs_counter (
	host TEXT NOT NULL,
	name TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (host, name)
);
`,
	},
];

/** Opens (creating and migrating) `obs.db` at `path`, or `:memory:`. Throws when it cannot: the logger turns that into a no-op. */
export function openObsDb(path: string, o: OpenOptions = {}): Database {
	const memory = path === ":memory:";
	if (!memory) preparePrivateFile(path, o);
	const db = new Database(path, { create: true });
	try {
		db.exec("PRAGMA busy_timeout = 2000");
		if (!memory) db.exec("PRAGMA journal_mode = WAL");
		applyMigrations(db, OBS_MIGRATIONS, (found) => new ObsTooNewError(path, found));
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("PRAGMA wal_autocheckpoint = 0");
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

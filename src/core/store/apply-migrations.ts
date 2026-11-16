/**
 * Applies a list of versioned SQL migrations to an open database: each once, in order, inside one exclusive
 * transaction, and recorded in the `migrations` table. Both databases use it (`chamberlain.db`,
 * src/core/store/sqlite-store.ts, and `obs.db`, src/core/obs/db.ts), each with its own list.
 * A database whose newest recorded migration is newer than the list's last is refused through `tooNew`.
 *
 * #67: BEGIN EXCLUSIVE is taken before reading the schema version, so the version check, every pending
 * migration, and (on a ≤14→16 upgrade) the exact historical id set commit as one unit. A crash or failure
 * mid-batch leaves the prior schema; another writer cannot insert between migration 15 and 16.
 */
import type { Migration } from "./migrations.ts";

/** What this needs of a bun:sqlite Database, so the file that opens one is the only file that imports the driver. */
type Sqlite = {
	exec(sql: string): unknown;
	query(sql: string): { get(): unknown; run(...p: (string | number)[]): unknown };
};

const newest = (db: Sqlite): number =>
	(db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0;

/** #67: migration 16 records the exact pre-v2 delivered set only when this open upgrades from ≤14. */
function markPreV2UpgradeIfNeeded(db: Sqlite, migrationVersion: number, startingVersion: number): void {
	if (migrationVersion !== 16 || startingVersion > 14) return;
	db.query("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)").run(
		"steward.adopt.pre_v2_upgrade",
		"true",
		Date.now(),
	);
}

function applyOne(db: Sqlite, m: Migration, startingVersion: number, appliedAt: string): void {
	markPreV2UpgradeIfNeeded(db, m.version, startingVersion);
	db.exec(m.sql);
	db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, appliedAt);
}

export function applyMigrations(db: Sqlite, list: readonly Migration[], tooNew: (found: number) => Error): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	// Exclusive lock before the version read: no other connection can commit outbox rows (or migrations)
	// between the snapshot we classify and the commit that records schema 16 + historical_ids.
	db.exec("BEGIN EXCLUSIVE");
	try {
		const startingVersion = newest(db);
		if (startingVersion > (list.at(-1)?.version ?? 0)) throw tooNew(startingVersion);
		const appliedAt = new Date().toISOString();
		for (const m of list) {
			if (m.version <= startingVersion) continue;
			// Another process may have applied it while this one waited for the exclusive lock.
			if (m.version > newest(db)) applyOne(db, m, startingVersion, appliedAt);
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

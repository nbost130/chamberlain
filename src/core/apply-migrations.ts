/**
 * Applies a list of versioned SQL migrations to an open database: each once, in order, inside its own transaction, and recorded in the
 * `migrations` table. Both databases use it (`chamberlain.db`, src/core/sqlite-store.ts, and `obs.db`, src/core/obs/db.ts), each with its own list.
 * A database whose newest recorded version is newer than the list's last is refused through `tooNew`.
 */
import type { Migration } from "./migrations.ts";

/** What this needs of a bun:sqlite Database, so the file that opens one is the only file that imports the driver. */
type Sqlite = {
	exec(sql: string): unknown;
	query(sql: string): { get(): unknown; run(...p: (string | number)[]): unknown };
};

export function applyMigrations(db: Sqlite, list: readonly Migration[], tooNew: (found: number) => Error): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const newest = () => (db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0;
	const found = newest();
	if (found > (list.at(-1)?.version ?? 0)) throw tooNew(found);
	for (const m of list) {
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

/**
 * #67 Sol fix-round 2: pre-v2→16 must be one exclusive transaction.
 * Crash/fail after 15's SQL leaves schema ≤14; interleaved writers cannot enter the historical set.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { applyMigrations } from "../store/apply-migrations.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { openStore } from "../store/sqlite-store.ts";
import { historicalAdoptIds } from "./steward-adopt.ts";
import { recoverSteward } from "./steward-recover.ts";
import { transferItemId } from "./steward-transfer.ts";
import { HISTORICAL_ADOPT_IDS_KEY } from "./steward-types.ts";

const { confWorld, fakeClock } = useStewardSwitchFixtures();

type Sqlite = {
	exec(sql: string): unknown;
	query(sql: string): { get(): unknown; run(...p: (string | number)[]): unknown };
};

function schemaVersion(path: string): number {
	const db = new Database(path);
	const v = (db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null } | null)?.v ?? 0;
	db.close();
	return v;
}

function adoptKeys(path: string): string[] {
	const db = new Database(path);
	const keys = db
		.query("SELECT key FROM state WHERE key LIKE 'steward.adopt.%' ORDER BY key")
		.all()
		.map((r) => (r as { key: string }).key);
	db.close();
	return keys;
}

/** Schema-14 DB with one delivered Steward payload (id 1). */
function fixture14(dir: string, name: string): string {
	const path = `${dir}/${name}.db`;
	const db = new Database(path);
	applyMigrations(
		db,
		MIGRATIONS.filter((m) => m.version <= 14),
		() => new Error("too new"),
	);
	db.run(
		`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
		 VALUES ('old', 'historical payload', NULL, 't', NULL, 1, 0, 'delivered', 0, 1)`,
	);
	db.close();
	return path;
}

describe("#67 atomic pre-v2→16 boundary", () => {
	test("fail after migration 15 SQL rolls back to schema ≤14 — never 15 without the set", () => {
		const dir = mkdtempSync(`${tmpdir()}/h67-atomic-`);
		const path = fixture14(dir, "fail-after-15");
		const db = new Database(path);
		let saw15 = false;
		const wrapped: Sqlite = {
			query: (s) => db.query(s),
			exec: (sql) => {
				const r = db.exec(sql);
				if (sql === MIGRATIONS.find((m) => m.version === 15)!.sql) {
					saw15 = true;
					throw new Error("INJECTED_AFTER_V15_SQL");
				}
				return r;
			},
		};
		expect(() => applyMigrations(wrapped, MIGRATIONS, () => new Error("too new"))).toThrow(/INJECTED_AFTER_V15/);
		expect(saw15).toBe(true);
		db.close();
		expect(schemaVersion(path)).toBe(14);
		expect(adoptKeys(path)).toEqual([]);

		const w = confWorld();
		const store = openStore(path);
		expect(schemaVersion(path)).toBe(16);
		expect([...historicalAdoptIds(store)]).toEqual([1]);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: 50 });
		expect(store.steward.ledger(1)).toMatchObject({ origin: "adopted-historical" });
		expect(store.steward.transferItemForOrig(0, 1)).toBeUndefined();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("migration 16 throws — restart from ≤14 records the full set", () => {
		const dir = mkdtempSync(`${tmpdir()}/h67-atomic-`);
		const path = fixture14(dir, "fail-16");
		const db = new Database(path);
		const wrapped: Sqlite = {
			query: (s) => db.query(s),
			exec: (sql) => {
				const r = db.exec(sql);
				if (sql === MIGRATIONS.find((m) => m.version === 16)!.sql) throw new Error("INJECTED_V16");
				return r;
			},
		};
		expect(() => applyMigrations(wrapped, MIGRATIONS, () => new Error("too new"))).toThrow(/INJECTED_V16/);
		db.close();
		expect(schemaVersion(path)).toBe(14);
		expect(adoptKeys(path)).toEqual([]);

		const w = confWorld();
		const store = openStore(path);
		expect([...historicalAdoptIds(store)]).toEqual([1]);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: 50 });
		expect(store.steward.ledger(1)).toMatchObject({ origin: "adopted-historical" });
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("interleaved writer after exclusive upgrade is not marked historical", () => {
		const dir = mkdtempSync(`${tmpdir()}/h67-atomic-`);
		const path = fixture14(dir, "interleave");
		const w = confWorld();
		const clock = fakeClock();

		// Exclusive batch: no COMMIT between 15 and 16, so a second connection cannot land in that gap.
		// Prove the post-upgrade F2 shape: a live unstamped delivery after openStore is not in the set.
		const store = openStore(path);
		expect(store.state.get(HISTORICAL_ADOPT_IDS_KEY)).toEqual([1]);
		expect(historicalAdoptIds(store).has(1)).toBe(true);

		store.wakes.enqueue({ deliveryId: "live", message: "live v2 late landing", queuedAt: clock.t });
		const live = store.wakes.find("live")!;
		store.wakes.finish(live.id, "delivered", clock.t + 1);
		expect(historicalAdoptIds(store).has(live.id)).toBe(false);

		const r = recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 2,
		});
		expect(store.steward.ledger(1)).toMatchObject({ origin: "adopted-historical" });
		expect(store.steward.ledger(live.id)).toMatchObject({ origin: "adopted" });
		expect(store.wakes.held(null).some((h) => h.deliveryId === transferItemId(live.id, 0))).toBe(true);
		expect(r.adopted).toBeGreaterThanOrEqual(1);
		store.close();

		// Concurrent INSERT while exclusive migration holds the lock is serialized (busy), then lands after.
		const path2 = fixture14(dir, "busy");
		const migrator = new Database(path2);
		let midBatchInsertOk = false;
		const wrapped: Sqlite = {
			query: (s) => migrator.query(s),
			exec: (sql) => {
				const r = migrator.exec(sql);
				if (sql === MIGRATIONS.find((m) => m.version === 15)!.sql) {
					const other = new Database(path2, { create: false });
					other.exec("PRAGMA busy_timeout = 50");
					try {
						other.run(
							`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at, attempt_gen)
							 VALUES ('sneak', 'during exclusive', NULL, 't', NULL, 2, 0, 'delivered', 0, 2, NULL)`,
						);
						midBatchInsertOk = true;
					} catch {
						midBatchInsertOk = false;
					}
					other.close();
				}
				return r;
			},
		};
		applyMigrations(wrapped, MIGRATIONS, () => new Error("too new"));
		migrator.close();
		// Under BEGIN EXCLUSIVE the mid-batch insert must fail or wait; it must not commit into the historical snapshot.
		expect(midBatchInsertOk).toBe(false);
		const after = openStore(path2);
		expect([...historicalAdoptIds(after)]).toEqual([1]);
		expect(after.wakes.find("sneak")).toBeUndefined();
		after.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

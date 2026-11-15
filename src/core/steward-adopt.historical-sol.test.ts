/**
 * #67 Sol fix-round 1: three reproductions that a max-id watermark gets wrong.
 * Exact historical_ids membership; schema-15 invents no set.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore } from "./sqlite-store.ts";
import { historicalAdoptIds } from "./steward-adopt.ts";
import { recoverSteward } from "./steward-recover.ts";
import { transferItemId } from "./steward-transfer.ts";
import { HISTORICAL_ADOPT_IDS_KEY } from "./steward-types.ts";

const { confWorld, fakeClock } = useStewardSwitchFixtures();

function applyMigrationsThrough(dbPath: string, through: number) {
	const db = new Database(dbPath);
	db.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);",
	);
	for (const m of MIGRATIONS) {
		if (m.version > through) break;
		db.exec("BEGIN");
		db.exec(m.sql);
		db.run("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)", [
			m.version,
			m.name,
			new Date().toISOString(),
		]);
		db.exec("COMMIT");
	}
	db.close();
}

function insertDelivered(
	raw: Database,
	o: { deliveryId: string; message: string; at: number; attemptGen?: number | null },
): number {
	raw.run(
		`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at, attempt_gen)
		 VALUES (?, ?, NULL, 't', NULL, ?, 0, 'delivered', 0, ?, ?)`,
		[o.deliveryId, o.message, o.at, o.at, o.attemptGen === undefined ? null : o.attemptGen],
	);
	return (raw.query("SELECT id FROM outbox WHERE delivery_id = ?").get(o.deliveryId) as { id: number }).id;
}

describe("#67 Sol reproductions (exact historical set)", () => {
	test("Sol A: pending below a delivered id, finished after upgrade, transfers", () => {
		const w = confWorld();
		const clock = fakeClock();
		const dbPath = `${w.state}/sol-a.db`;
		applyMigrationsThrough(dbPath, 14);
		const raw = new Database(dbPath);
		raw.run(
			`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
			 VALUES ('sol-a-pending', 'pending then land', NULL, 't', NULL, ?, 0, 'pending', 0, NULL)`,
			[clock.t],
		);
		const pendingId = (raw.query("SELECT id FROM outbox WHERE delivery_id = 'sol-a-pending'").get() as { id: number })
			.id;
		raw.run(
			`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
			 VALUES ('sol-a-delivered', 'already delivered', NULL, 't', NULL, ?, 0, 'delivered', 0, ?)`,
			[clock.t + 1, clock.t + 1],
		);
		const deliveredId = (
			raw.query("SELECT id FROM outbox WHERE delivery_id = 'sol-a-delivered'").get() as { id: number }
		).id;
		raw.close();
		expect(pendingId).toBeLessThan(deliveredId);

		const store = openStore(dbPath);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t + 2 });
		expect(historicalAdoptIds(store).has(deliveredId)).toBe(true);
		expect(historicalAdoptIds(store).has(pendingId)).toBe(false);
		expect(store.steward.ledger(deliveredId)?.origin).toBe("adopted-historical");
		expect(store.wakes.finish(pendingId, "delivered", clock.t + 3)).toBe(true);
		store.close();

		const again = openStore(dbPath);
		const r = recoverSteward({
			store: again,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 4,
		});
		expect(r.adopted).toBe(1);
		expect(again.steward.ledger(pendingId)).toMatchObject({ origin: "adopted" });
		expect(again.wakes.held(null).some((h) => h.deliveryId === transferItemId(pendingId, 0))).toBe(true);
		again.close();
	});

	test("Sol B: attempt_gen=1 below an unstamped delivered id is not historical", () => {
		const w = confWorld();
		const clock = fakeClock();
		const dbPath = `${w.state}/sol-b.db`;
		applyMigrationsThrough(dbPath, 15);
		const raw = new Database(dbPath);
		const stampedId = insertDelivered(raw, {
			deliveryId: "sol-b-stamped",
			message: "known gen",
			at: clock.t,
			attemptGen: 1,
		});
		const plainId = insertDelivered(raw, {
			deliveryId: "sol-b-plain",
			message: "unstamped",
			at: clock.t + 1,
			attemptGen: null,
		});
		raw.close();
		expect(stampedId).toBeLessThan(plainId);

		const store = openStore(dbPath);
		expect(store.state.get(HISTORICAL_ADOPT_IDS_KEY)).toBeUndefined();
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t + 2 });
		expect(historicalAdoptIds(store).size).toBe(0);
		expect(store.steward.ledger(stampedId)).toMatchObject({ origin: "adopted" });
		expect(store.steward.ledger(plainId)).toMatchObject({ origin: "adopted" });
		expect(store.steward.transferItemForOrig(0, stampedId)).toBeDefined();
		expect(store.steward.transferItemForOrig(0, plainId)).toBeDefined();
		store.close();
	});

	test("Sol C: schema-15 F2 late landing transfers — no invented historical set", () => {
		const w = confWorld();
		const clock = fakeClock();
		const dbPath = `${w.state}/sol-c.db`;
		applyMigrationsThrough(dbPath, 15);
		const raw = new Database(dbPath);
		const lateId = insertDelivered(raw, {
			deliveryId: "sol-c-late",
			message: "f2 late land",
			at: clock.t,
			attemptGen: null,
		});
		raw.close();

		const store = openStore(dbPath);
		expect(store.state.get(HISTORICAL_ADOPT_IDS_KEY)).toBeUndefined();
		const r = recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 1,
		});
		expect(r.adopted).toBe(1);
		expect(store.steward.ledger(lateId)).toMatchObject({ origin: "adopted" });
		expect(store.wakes.held(null).some((h) => h.deliveryId === transferItemId(lateId, 0))).toBe(true);
		store.close();
	});
});

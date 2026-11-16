/**
 * #67: upgrading a 0.3.x (schema 14) database must adopt pre-upgrade delivered Steward rows as
 * adopted-historical — zero held transfers, zero sends, zero dead letters, no oversized alarm.
 * Exact id-set membership (not a max-id watermark). Schema-15 upgrades invent no historical set.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { openStore } from "../store/sqlite-store.ts";
import type { Store } from "../store/store.ts";
import { adoptPass, historicalAdoptIds } from "./steward-adopt.ts";
import { recoverSteward } from "./steward-recover.ts";
import { holdTransferItem } from "./steward-transfer.ts";
import { TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";

const { confWorld, fakeClock } = useStewardSwitchFixtures();

const RETIRED_THREAD = "mcp:launch:retired-steward-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIVE_THREAD = "thread-g1-steward";
const OVERSIZE = "x".repeat(25_000);

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

describe("#67 historical adoption of pre-v2 delivered Steward rows", () => {
	test("schema-14 fixture: N delivered (oversized + retired thread) → historical, zero transfers/sends/dead letters", () => {
		const w = confWorld({ stewardThread: LIVE_THREAD });
		const clock = fakeClock(1_794_776_000_000);
		const dbPath = `${w.state}/chamberlain.db`;
		applyMigrationsThrough(dbPath, 14);

		const raw = new Database(dbPath);
		const deliveredIds: number[] = [];
		const add = (o: { deliveryId: string; message: string; thread: string; at: number }) => {
			raw.run(
				`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
				 VALUES (?, ?, NULL, ?, NULL, ?, 0, 'delivered', 0, ?)`,
				[o.deliveryId, o.message, o.thread, o.at, o.at],
			);
			deliveredIds.push(
				(raw.query("SELECT id FROM outbox WHERE delivery_id = ?").get(o.deliveryId) as { id: number }).id,
			);
		};
		add({ deliveryId: "h67-a", message: "normal wake a", thread: RETIRED_THREAD, at: clock.t });
		add({ deliveryId: "h67-b", message: "normal wake b", thread: RETIRED_THREAD, at: clock.t + 1 });
		add({ deliveryId: "h67-over-1", message: OVERSIZE, thread: RETIRED_THREAD, at: clock.t + 2 });
		add({ deliveryId: "h67-over-2", message: OVERSIZE, thread: LIVE_THREAD, at: clock.t + 3 });
		add({ deliveryId: "h67-c", message: "normal wake c", thread: LIVE_THREAD, at: clock.t + 4 });
		raw.run(
			`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
			 VALUES ('h67-pending', 'still pending', NULL, ?, NULL, ?, 0, 'pending', 0, NULL)`,
			[LIVE_THREAD, clock.t + 5],
		);
		const pendingId = (raw.query("SELECT id FROM outbox WHERE delivery_id = 'h67-pending'").get() as { id: number }).id;
		raw.close();

		const alarms: string[] = [];
		const store = openStore(dbPath);
		const ids = historicalAdoptIds(store);
		expect([...ids].sort((a, b) => a - b)).toEqual([...deliveredIds].sort((a, b) => a - b));
		expect(ids.has(pendingId)).toBe(false);

		const r = recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 10,
			alarm: (key) => {
				alarms.push(key);
			},
		});

		expect(r.adopted).toBe(5);
		expect(store.wakes.held(null).filter((h) => h.kind === "transfer")).toHaveLength(0);
		expect(store.steward.itemsOfTransfer(0)).toHaveLength(0);
		expect(store.wakes.rows("dead_letter", null)).toHaveLength(0);
		expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(false);

		for (const id of deliveredIds) {
			expect(store.steward.ledger(id)).toMatchObject({ gen: 0, origin: "adopted-historical" });
			expect(store.steward.transferItemForOrig(0, id)).toBeUndefined();
		}
		expect(store.wakes.find("h67-pending")?.status).toBe("pending");
		expect(store.steward.ledger(pendingId)).toBeUndefined();

		const notice = store.wakes.find("adopt-historical-notice");
		expect(notice?.status).toBe("pending");
		expect(notice?.message).toContain("Adopted 5 historical wakes, none replayed");
		expect(Buffer.byteLength(notice!.message, "utf8")).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);

		const again = recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 11,
			alarm: (key) => {
				alarms.push(key);
			},
		});
		expect(again.adopted).toBe(0);
		expect(store.wakes.held(null).filter((h) => h.kind === "transfer")).toHaveLength(0);
		store.close();
	});

	test("post-set delivered-without-ledger still transfers; pending is untouched by adopt", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = openStore(`${w.state}/post-set.db`);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t });
		expect(historicalAdoptIds(store).size).toBe(0);

		store.wakes.enqueue({ deliveryId: "post-pending", message: "pending body", queuedAt: clock.t + 1 });
		store.wakes.enqueue({ deliveryId: "post-delivered", message: "needs transfer", queuedAt: clock.t + 2 });
		const row = store.wakes.find("post-delivered")!;
		store.wakes.finish(row.id, "delivered", clock.t + 2);

		const a = adoptPass(store, () => undefined, clock.t + 3);
		expect(a.historical).toBe(0);
		expect(a.transferItems).toBe(1);
		expect(store.steward.ledger(row.id)).toMatchObject({ origin: "adopted" });
		expect(store.wakes.find("post-pending")?.status).toBe("pending");
		store.close();
	});

	test("exact-set member wrongly ledgered as adopted remediates", () => {
		const w = confWorld();
		const clock = fakeClock();
		const dbPath = `${w.state}/remediate.db`;
		applyMigrationsThrough(dbPath, 14);
		const raw = new Database(dbPath);
		raw.run(
			`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
			 VALUES ('rem-1', 'legacy', NULL, 'old-thread', NULL, ?, 0, 'delivered', 0, ?)`,
			[clock.t, clock.t],
		);
		const origId = (raw.query("SELECT id FROM outbox WHERE delivery_id = 'rem-1'").get() as { id: number }).id;
		raw.close();

		const store = openStore(dbPath);
		expect(historicalAdoptIds(store).has(origId)).toBe(true);
		seedWrongAdopt(store, origId, clock.t + 1);
		expect(store.steward.ledger(origId)?.origin).toBe("adopted");

		const r = recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
			now: clock.t + 2,
		});
		expect(r.adopted).toBe(1);
		expect(store.steward.ledger(origId)).toMatchObject({ origin: "adopted-historical" });
		expect(store.wakes.held(null).filter((h) => h.kind === "transfer")).toHaveLength(0);
		store.close();
	});
});

function seedWrongAdopt(store: Store, outboxId: number, now: number) {
	store.tx(() => {
		if (store.steward.maxGen() < 1) {
			store.steward.insertGen({
				gen: 1,
				thread: "thread-g1-steward",
				wakeRef: "wake-url",
				createdAt: now,
			});
		}
		store.steward.insertLedger({ outboxId, gen: 0, origin: "adopted" });
		const toGen = store.steward.maxGen();
		if (!store.steward.transfer(0)) {
			store.steward.insertTransfer({
				fromGen: 0,
				toGen,
				receiptHw: 0,
				noticeId: `adopt-notice:g0→g${toGen}`,
				openedAt: now,
			});
		}
	});
	holdTransferItem(store, { fromGen: 0, origOutboxId: outboxId, adoption: true }, now);
}

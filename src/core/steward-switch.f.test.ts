/**
 * F. Adoption (B3). F1 uses a v14-shaped DB (migrations 1–14 applied, then rows inserted, then migrate to 15).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore } from "./sqlite-store.ts";
import { adoptPass } from "./steward-adopt.ts";
import { recoverSteward } from "./steward-recover.ts";
import { transferItemId } from "./steward-transfer.ts";

const { confWorld, scratch, fakeClock } = useStewardSwitchFixtures();

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

describe("F. adoption (B3)", () => {
	test("F1: v14 fixture migrated to 15 — receipted/payload/empty/pending/dead/digest/desk/tombstone", () => {
		const w = confWorld();
		const clock = fakeClock();
		const dbPath = `${w.state}/chamberlain.db`;
		applyMigrationsThrough(dbPath, 14);

		const raw = new Database(dbPath);
		const ins = (
			deliveryId: string,
			message: string,
			status: string,
			o: { receiver?: string; kind?: string; folded?: number; finished?: number } = {},
		) => {
			raw.run(
				`INSERT INTO outbox (delivery_id, message, kind, thread, receiver, created_at, folded, status, attempts, finished_at)
				 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?)`,
				[
					deliveryId,
					message,
					o.kind ?? null,
					o.receiver ?? null,
					clock.t,
					o.folded ?? 0,
					status,
					o.finished ?? (status === "delivered" || status === "dead_letter" ? clock.t : null),
				],
			);
			return raw.query("SELECT id FROM outbox WHERE delivery_id = ?").get(deliveryId) as { id: number };
		};
		const receipted = ins("f1-receipted", "seen payload", "delivered");
		const payload = ins("f1-payload", "unseen payload body", "delivered");
		const empty = ins("f1-empty", "", "delivered");
		ins("f1-pending", "pending body", "pending");
		ins("f1-dead", "dead body", "dead_letter");
		const digest = ins("f1-digest", "digest envelope", "delivered", { kind: "digest", folded: 1 });
		raw.run(`INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, ?, NULL)`, [
			"f1-member-a",
			digest.id,
			clock.t,
			"sweep",
		]);
		raw.run(`INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, ?, NULL)`, [
			"f1-member-b",
			digest.id,
			clock.t,
			"sweep",
		]);
		ins("f1-desk", "desk body", "delivered", { receiver: "desk" });
		raw.run(`INSERT INTO wake_tombstones (delivery_id, outcome, ended_at) VALUES (?, 'delivered', ?)`, [
			"f1-tombstone-only",
			clock.t,
		]);
		raw.close();

		// Migrate to 15 via openStore.
		const store = openStore(dbPath);
		// Seed gen1 from conf.
		const find = (o: { deliveryId: string }) =>
			o.deliveryId === "f1-receipted"
				? { outboxId: receipted.id, runId: "run-f1", thread: w.stewardThread, recordedAt: clock.t }
				: undefined;
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: find, now: clock.t });

		// Pre-v2 delivered rows settle as historical: no receipt hunt, no transfer, no held wake (#67).
		expect(store.steward.ledger(receipted.id)).toMatchObject({ gen: 0, origin: "adopted-historical" });
		expect(store.steward.receiptFor(receipted.id)).toBeUndefined();
		expect(store.steward.transferItemForOrig(0, receipted.id)).toBeUndefined();

		expect(store.steward.ledger(payload.id)).toMatchObject({ gen: 0, origin: "adopted-historical" });
		expect(store.steward.transferItemForOrig(0, payload.id)).toBeUndefined();
		expect(store.wakes.held(null).some((h) => h.deliveryId === transferItemId(payload.id, 0))).toBe(false);

		expect(store.steward.ledger(empty.id)).toMatchObject({ origin: "adopted-historical" });

		expect(store.wakes.find("f1-pending")?.status).toBe("pending");
		expect(store.steward.ledger(store.wakes.find("f1-pending")!.id)).toBeUndefined();

		expect(store.wakes.find("f1-dead")?.status).toBe("dead_letter");
		expect(store.steward.ledger(store.wakes.find("f1-dead")!.id)).toBeUndefined();

		expect(store.steward.ledger(digest.id)).toMatchObject({ origin: "adopted-historical" });
		expect(store.steward.transferItemForOrig(0, digest.id)).toBeUndefined();

		expect(store.steward.ledger(store.wakes.find("f1-desk")!.id)).toBeUndefined();
		expect(store.wakes.held(null).filter((h) => h.kind === "transfer")).toHaveLength(0);
		store.close();
	});

	test("F2: late land after schema 15 is adopted on next recovery", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = openStore(`${w.state}/chamberlain.db`);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t });
		// Simulate old relay landing a delivered row without ledger (INSERT bypassing land()).
		store.wakes.enqueue({ deliveryId: "f2-late", message: "late payload", queuedAt: clock.t });
		const row = store.wakes.find("f2-late")!;
		store.wakes.finish(row.id, "delivered", clock.t);
		expect(store.steward.ledger(row.id)).toBeUndefined();

		const r = recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t + 1 });
		expect(r.adopted).toBe(1);
		expect(store.steward.ledger(row.id)).toMatchObject({ gen: 0, origin: "adopted" });
		store.close();
	});

	test("F3: adoption is idempotent across restarts", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = openStore(`${w.state}/f3.db`);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t });
		store.wakes.enqueue({ deliveryId: "f3", message: "p", queuedAt: clock.t });
		const row = store.wakes.find("f3")!;
		store.wakes.finish(row.id, "delivered", clock.t);

		const a = adoptPass(store, () => undefined, clock.t);
		expect(a.adopted).toBe(1);
		const b = adoptPass(store, () => undefined, clock.t + 1);
		expect(b.adopted).toBe(0);
		recoverSteward({ store, conf: w.conf, log: () => {}, findReceipt: () => undefined, now: clock.t + 2 });
		expect(store.steward.itemsOfTransfer(0)).toHaveLength(1);
		store.close();
	});
});

void scratch;

/** E. Retention (B2): unseen Steward rows survive prune; discharged prune; wakes release. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { DELIVERED_KEEP_MS } from "./deliver.ts";
import { commitSwitch } from "./steward-commit.ts";
import { releaseWake } from "./steward-discharge.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, fakeClock, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();

describe("E. retention (B2)", () => {
	test("E1: unseen R survives maintain 31 days later; forced switch transfers full payload", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const payload = "full frozen payload for E1 — must survive";
		const id = deliverAndLedger(store, { deliveryId: "R-e1", message: payload, at: clock.t, gen: 1 });
		const before = clock.t + DELIVERED_KEEP_MS + 86_400_000; // 31 days past keep
		expect(store.wakes.prune(before)).toBe(0);
		expect(store.wakes.find("R-e1")).toBeDefined();

		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: before });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: before }).ok).toBe(true);
		transferPass(store, before);
		const item = store.steward.transferItemForOrig(1, id)!;
		const held = store.wakes.held(null).find((h) => h.deliveryId === item.itemId)!;
		expect(held.message).toContain(payload);
	});

	test("E2: discharged rows prune; wakes release lets a row prune; desk/cancelled as today", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const id = deliverAndLedger(store, { deliveryId: "R-e2", message: "m", at: clock.t, gen: 1 });
		expect(releaseWake(store, "R-e2", clock.t)).toBe(true);
		expect(store.steward.receiptFor(id)?.kind).toBe("operator");
		const before = clock.t + DELIVERED_KEEP_MS + 1;
		expect(store.wakes.prune(before)).toBe(1);
		expect(store.wakes.find("R-e2")).toBeUndefined();

		// Desk row prunes without steward discharge.
		store.wakes.enqueue({
			deliveryId: "desk-e2",
			message: "d",
			queuedAt: clock.t,
			receiver: "desk",
		});
		const desk = store.wakes.find("desk-e2")!;
		store.wakes.finish(desk.id, "delivered", clock.t);
		expect(store.wakes.prune(before)).toBe(1);

		// Cancelled tombstone prunes.
		store.wakes.enqueue({ deliveryId: "cancel-e2", message: "c", queuedAt: clock.t });
		store.wakes.cancel("cancel-e2", clock.t);
		expect(store.wakes.prune(before)).toBe(1);
	});
});

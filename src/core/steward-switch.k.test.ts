/** K. Digests and receivers. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { composeWake } from "./hold.ts";
import { commitSwitch } from "./steward-commit.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { stewardStatus } from "./steward-status.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, fakeClock, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();

describe("K. digests and receivers", () => {
	test("K1: digest of three members (one folded) becomes one item; status --id resolves", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		// Build a digest outbox row with three members, one folded conceptually.
		store.wakes.hold({
			deliveryId: "m1",
			message: "one",
			queuedAt: clock.t,
			kind: "sweep",
			thread: "th-a",
		});
		store.wakes.hold({
			deliveryId: "m2",
			message: "two",
			queuedAt: clock.t + 1,
			kind: "sweep",
			thread: "th-a",
		});
		store.wakes.hold({
			deliveryId: "m3",
			message: "three",
			queuedAt: clock.t + 2,
			kind: "sweep",
			thread: "th-b",
		});
		const dig = store.wakes.compose(clock.t, (held) => composeWake(held, clock.t))!;
		expect(dig.folded).toBeGreaterThanOrEqual(1);
		store.wakes.finish(dig.id, "delivered", clock.t);
		store.steward.insertLedger({ outboxId: dig.id, gen: 1, origin: "live" });

		const prep = prepareSwitch(store, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		transferPass(store, clock.t);
		expect(store.steward.transferItemForOrig(1, dig.id)).toBeDefined();
		const lines = stewardStatus(store, "m1");
		expect(lines.some((l) => l.includes("m1") || l.includes(String(dig.id)))).toBe(true);
	});

	test("K2: transfer items never fold with normal wakes about the same subject", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const id = deliverAndLedger(store, { deliveryId: "R-k2", message: "orig", at: clock.t, gen: 1 });
		const prep = prepareSwitch(store, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		transferPass(store, clock.t);

		store.wakes.hold({
			deliveryId: "normal-sweep",
			message: "normal",
			queuedAt: clock.t,
			kind: "sweep",
			thread: "same-th",
		});
		const held = store.wakes.held(null);
		const composed = composeWake(held, clock.t);
		// Transfer items have no thread → never folded into the sweep.
		expect(composed.folded).toBe(0);
		expect(composed.kept.length).toBe(held.length);
		void id;
	});

	test("K3: desk row in flight at commit is never ledgered or transferred", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		store.wakes.enqueue({
			deliveryId: "desk-k3",
			message: "d",
			queuedAt: clock.t,
			receiver: "desk",
		});
		const desk = store.wakes.find("desk-k3")!;
		store.wakes.finish(desk.id, "delivered", clock.t);
		const prep = prepareSwitch(store, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		transferPass(store, clock.t);
		expect(store.steward.ledger(desk.id)).toBeUndefined();
		expect(store.steward.transferItemForOrig(1, desk.id)).toBeUndefined();
	});

	test("K4: receiver string 'steward' is not in the Steward lane", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		store.wakes.enqueue({
			deliveryId: "recv-steward",
			message: "m",
			queuedAt: clock.t,
			receiver: "steward",
		});
		const row = store.wakes.find("recv-steward")!;
		store.wakes.finish(row.id, "delivered", clock.t);
		// land() only ledgers !row.receiver; simulate that.
		expect(store.steward.ledger(row.id)).toBeUndefined();
		const prep = prepareSwitch(store, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		transferPass(store, clock.t);
		expect(store.steward.transferItemForOrig(1, row.id)).toBeUndefined();
	});
});

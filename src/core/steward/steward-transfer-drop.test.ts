/** Held transfer items whose original turns out to be handled before the switch are given up, and the evidence pass finds that proof. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { commitSwitch } from "./steward-commit.ts";
import { countingReceipt, isDischarged } from "./steward-discharge.ts";
import { evidencePass } from "./steward-evidence.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();

function switchTo(store: ReturnType<typeof memStoreSeeded>, conf: string, thread: string, now: number) {
	const p = prepareSwitch(store, conf, { toThread: thread, live: true, now });
	if (!p.ok) throw new Error(p.error);
	writeSwitchRefs(conf, p.id);
	expect(commitSwitch(store, conf, { id: p.id, live: true, now }).ok).toBe(true);
}

describe("transfers of wakes the retired Steward already handled", () => {
	test("a held transfer whose original gets a pre-switch receipt is given up for good: tombstoned, never sent, never held again", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 2_000);
		expect(transferPass(s, 2_000)).toMatchObject({ held: 1, dropped: 0 });
		const item = s.steward.transferItemForOrig(1, id)!;
		expect(s.wakes.held(null).map((h) => h.deliveryId)).toContain(item.itemId);
		// The proof arrives late: the retired Steward's run completed at 1 500, before the switch at 2 000.
		s.steward.insertReceipt({ outboxId: id, kind: "t3-run", runId: "run-R", thread: "g1", recordedAt: 1_500 });
		expect(transferPass(s, 3_000).dropped).toBe(1);
		expect(s.wakes.held(null).map((h) => h.deliveryId)).not.toContain(item.itemId);
		expect(s.wakes.find(item.itemId)).toMatchObject({ status: "cancelled" });
		// Only the switch notice is pending: no row carries the given-up item.
		expect(s.wakes.rows("pending").map((r) => r.kind)).toEqual(["switch_notice"]);
		expect(transferPass(s, 4_000)).toMatchObject({ held: 0, dropped: 0 });
		expect(s.wakes.held(null).map((h) => h.deliveryId)).not.toContain(item.itemId);
	});

	test("a run the retired Steward completed before the switch counts, though its receipt is recorded after", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 2_000);
		const opened = s.steward.transfer(1)!.openedAt;
		expect(s.steward.transfer(1)!.receiptHw).toBe(0);
		s.steward.insertReceipt({ outboxId: id, kind: "t3-run", runId: "handled", thread: "old", recordedAt: opened });
		expect(countingReceipt(s, id)).toBe(true);
		expect(isDischarged(s, id)).toBe(true);
		// An operator's receipt is stamped when it is written, so after the switch it does not count by time.
		const op = deliverAndLedger(s, { deliveryId: "R-op", message: "payload", at: 1_000, gen: 1 });
		s.steward.insertReceipt({ outboxId: op, kind: "operator", recordedAt: opened - 1 });
		expect(countingReceipt(s, op)).toBe(false);
	});

	test("a held transfer whose original's run completed after the switch is still sent to the new Steward", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 2_000);
		transferPass(s, 2_000);
		s.steward.insertReceipt({ outboxId: id, kind: "t3-run", runId: "late", thread: "g1", recordedAt: 2_500 });
		expect(transferPass(s, 3_000).dropped).toBe(0);
		expect(s.wakes.held(null).map((h) => h.deliveryId)).toContain(s.steward.transferItemForOrig(1, id)!.itemId);
	});

	test("the evidence pass looks for a wake in the thread of the Steward it was delivered to, not only the current one", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const g1 = s.steward.gen(1)!.thread;
		deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 2_000);
		const asked: (string[] | undefined)[] = [];
		evidencePass(s, (c) => {
			asked.push(c.threads);
			return undefined;
		});
		expect(asked).toEqual([[g1]]);
	});
});

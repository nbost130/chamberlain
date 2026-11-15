/** J. Rollback (M1): forward switch to earlier refs; root/descendant closure. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { composeWake } from "./hold.ts";
import { secretPath } from "./layout.ts";
import { commitSwitch, mirrorSwitch } from "./steward-commit.ts";
import { isDischarged } from "./steward-discharge.ts";
import { prepareRollback, prepareSwitch } from "./steward-prepare.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, fakeClock, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();

function switchTo(store: ReturnType<typeof memStoreSeeded>, conf: string, thread: string, now: number) {
	const prep = prepareSwitch(store, conf, { toThread: thread, live: true, now });
	if (!prep.ok) throw new Error(prep.error);
	writeSwitchRefs(conf, prep.id);
	const c = commitSwitch(store, conf, { id: prep.id, live: true, now });
	if (!c.ok) throw new Error(c.error);
	mirrorSwitch(store, conf, prep.id);
	return prep.id;
}

describe("J. rollback (M1)", () => {
	test("J1: rollback is a forward switch to g1's refs; no new file written", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		switchTo(store, w.conf, "thread-g2", clock.t);
		const g1 = store.steward.gen(1)!;
		const wakeBefore = readFileSync(secretPath(w.conf, g1.wakeRef)!, "utf8");

		const rb = prepareRollback(store, w.conf, { toGen: 1, live: true, now: clock.t });
		expect(rb.ok).toBe(true);
		if (!rb.ok) return;
		expect(rb.rollback).toBe(true);
		const g1Wake = secretPath(w.conf, g1.wakeRef);
		if (!g1Wake) throw new Error("g1 wake missing");
		expect(rb.wakePath).toBe(g1Wake);
		expect(existsSync(`${w.conf}/secrets/steward/${rb.id}.wake`)).toBe(false);
		expect(commitSwitch(store, w.conf, { id: rb.id, live: true, now: clock.t }).ok).toBe(true);
		expect(store.steward.gen(3)?.wakeRef).toBe(g1.wakeRef);
		expect(readFileSync(g1Wake, "utf8")).toBe(wakeBefore);
	});

	test("J2: R g1→g2 unseen; rollback to g3; receipt on g3 closes both transfers", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const rId = deliverAndLedger(store, { deliveryId: "R-j2", message: "m", at: clock.t, gen: 1 });
		switchTo(store, w.conf, "thread-g2", clock.t);
		transferPass(store, clock.t);
		expect(store.steward.transferItemForOrig(1, rId)).toBeDefined();

		// Deliver the g1→g2 transfer item onto g2 (unseen).
		const composed = store.wakes.compose(clock.t, (held) =>
			composeWake(
				held.filter((h) => h.kind === "transfer"),
				clock.t,
			),
		)!;
		store.wakes.finish(composed.id, "delivered", clock.t);
		store.steward.insertLedger({ outboxId: composed.id, gen: 2, origin: "live" });

		const rb = prepareRollback(store, w.conf, { toGen: 1, live: true, now: clock.t });
		if (!rb.ok) throw new Error(rb.error);
		expect(commitSwitch(store, w.conf, { id: rb.id, live: true, now: clock.t }).ok).toBe(true);
		expect(store.steward.maxGen()).toBe(3);
		transferPass(store, clock.t);
		// Re-transfer of the g2 delivery (or original) should exist under g2→g3.
		expect(store.steward.transferItemForOrig(2, composed.id)).toBeDefined();

		const composed2 = store.wakes.compose(clock.t, (held) =>
			composeWake(
				held.filter((h) => h.kind === "transfer"),
				clock.t,
			),
		)!;
		store.wakes.finish(composed2.id, "delivered", clock.t);
		store.steward.insertLedger({ outboxId: composed2.id, gen: 3, origin: "live" });
		store.steward.insertReceipt({
			outboxId: composed2.id,
			kind: "t3-run",
			runId: "run-g3",
			thread: "thread-g1-steward",
			recordedAt: clock.t,
		});

		transferPass(store, clock.t);
		expect(isDischarged(store, rId)).toBe(true);
		expect(store.steward.transfer(1)?.closedAt).toBeDefined();
		expect(store.steward.transfer(2)?.closedAt).toBeDefined();
	});

	test("J4: rollback refused when wake ref missing", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		switchTo(store, w.conf, "thread-g2", clock.t);
		// Remove g1 wake ref.
		const g1 = store.steward.gen(1)!;
		unlinkSync(secretPath(w.conf, g1.wakeRef)!);
		const rb = prepareRollback(store, w.conf, { toGen: 1, live: true });
		expect(rb).toMatchObject({ ok: false, code: 2 });
		if (rb.ok) return;
		expect(rb.error).toContain("wake ref missing");
	});

	test("J5: repeated rollbacks never rewrite a ref", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const g1Wake = readFileSync(`${w.conf}/secrets/wake-url`, "utf8");
		switchTo(store, w.conf, "thread-g2", clock.t);
		for (let i = 0; i < 2; i++) {
			const rb = prepareRollback(store, w.conf, { toGen: 1, live: true, now: clock.t + i });
			if (!rb.ok) throw new Error(rb.error);
			expect(commitSwitch(store, w.conf, { id: rb.id, live: true, now: clock.t + i }).ok).toBe(true);
			mirrorSwitch(store, w.conf, rb.id);
			if (i === 0) switchTo(store, w.conf, `thread-again-${i}`, clock.t + i + 10);
		}
		expect(readFileSync(`${w.conf}/secrets/wake-url`, "utf8")).toBe(g1Wake);
	});
});

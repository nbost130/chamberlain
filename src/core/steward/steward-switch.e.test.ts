/** E. Retention (B2): unseen Steward rows survive prune; discharged prune; wakes release. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { DELIVERED_KEEP_MS } from "../delivery/deliver.ts";
import { maintain } from "../ops/maintain.ts";
import { commitSwitch } from "./steward-commit.ts";
import { isDischarged, releaseWake } from "./steward-discharge.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { stewardStatus } from "./steward-status.ts";
import { composeTransferBatch, transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, fakeClock, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();
const DAY = 24 * 3600_000;

function twoHandoffs(now: number) {
	const w = confWorld();
	const s = memStoreSeeded(w.conf, now);
	const roots = ["orig-A", "orig-B"].map((deliveryId) =>
		deliverAndLedger(s, { deliveryId, message: "payload", at: now, gen: 1 }),
	);
	const switchTo = (thread: string, t: number) => {
		const p = prepareSwitch(s, w.conf, { toThread: thread, live: true, now: t });
		if (!p.ok) throw new Error(p.error);
		writeSwitchRefs(w.conf, p.id);
		expect(commitSwitch(s, w.conf, { id: p.id, live: true, now: t }).ok).toBe(true);
	};
	const relayTo = (gen: number, t: number) => {
		switchTo(`g${gen}`, t);
		transferPass(s, t);
		const row = s.wakes.compose(t, (held) => composeTransferBatch(held, t)!, null)!;
		s.wakes.finish(row.id, "delivered", t);
		s.steward.insertLedger({ outboxId: row.id, gen, origin: "live" });
		return row;
	};
	expect(relayTo(2, now).members).toHaveLength(2);
	return { s, roots, last: relayTo(3, now), switchTo };
}

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

	test("E3: after two handoffs, day-40 prune keeps both originals settled (#116)", () => {
		const clock = fakeClock();
		const { s, roots, last } = twoHandoffs(clock.t);
		s.steward.insertReceipt({ outboxId: last.id, kind: "t3-run", runId: "run-g3", thread: "g3", recordedAt: clock.t });
		expect(roots.map((id) => isDischarged(s, id))).toEqual([true, true]);
		transferPass(s, clock.t);
		expect(s.steward.transfer(1)?.closedAt).toBeDefined();
		expect(s.steward.transfer(2)?.closedAt).toBeDefined();
		expect(stewardStatus(s).join("\n")).not.toMatch(/orig-[AB]/);
		clock.advance(40 * DAY);
		maintain(s, clock.t);
		expect(s.wakes.find("orig-A")).toBeUndefined();
		expect(s.wakes.find("orig-B")).toBeUndefined();
		expect(roots.map((id) => isDischarged(s, id))).toEqual([true, true]);
		expect(stewardStatus(s).join("\n")).not.toMatch(/orig-[AB]/);
	});

	test("E3c: an unresolved claim that keeps one original must not erase its descendant receipt", () => {
		const clock = fakeClock();
		const { s, roots, last } = twoHandoffs(clock.t);
		s.steward.insertReceipt({ outboxId: last.id, kind: "t3-run", runId: "run-g3", thread: "g3", recordedAt: clock.t });
		expect(roots.map((id) => isDischarged(s, id))).toEqual([true, true]);
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-keep1", mode: "silenced" });
		s.claims.claim("queue", {
			owner: "page",
			item: "Q-keep1",
			deliveryId: "orig-A",
			message: "keep A",
			t: new Date(clock.t).toISOString(),
		});
		clock.advance(40 * DAY);
		maintain(s, clock.t);
		expect(s.wakes.find("orig-A")).toBeDefined();
		expect(isDischarged(s, roots[0]!)).toBe(true);
		expect(stewardStatus(s).join("\n")).not.toMatch(/orig-A/);
	});

	test("E3b: a receipt outside the qualifying cutoff leaves originals outstanding after prune", () => {
		const clock = fakeClock();
		const { s, roots, last, switchTo } = twoHandoffs(clock.t);
		switchTo("g4", clock.t);
		s.steward.insertReceipt({
			outboxId: last.id,
			kind: "t3-run",
			runId: "late",
			thread: "g3",
			recordedAt: s.steward.transfer(3)!.openedAt + 1,
		});
		expect(roots.map((id) => isDischarged(s, id))).toEqual([false, false]);
		clock.advance(40 * DAY);
		maintain(s, clock.t);
		expect(s.wakes.find("orig-A")).toBeDefined();
		expect(s.wakes.find("orig-B")).toBeDefined();
		expect(roots.map((id) => isDischarged(s, id))).toEqual([false, false]);
		expect(stewardStatus(s).join("\n")).toMatch(/orig-A/);
		expect(stewardStatus(s).join("\n")).toMatch(/orig-B/);
	});
});

/**
 * Undelivered work is never dropped for its age. A wake that has not been delivered is the only record that
 * something needs the Steward, so it stays until it is delivered or explicitly cancelled; retention (maintain.ts) prunes only
 * terminal rows. Every test moves a fake clock: 25 hours (past the old one-day expiry), 8 days (past the old claim cutoff of 7
 * days) and 40 days (past the 30 days a delivery stays on record).
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { testRelayLock } from "../testing/lock.ts";
import { deliveredRow } from "../testing/relay.ts";
import { recordingWake } from "../testing/wake.ts";
import { createRelay } from "./relay.ts";
import { ITEM_KEEP_MS, maintain } from "./maintain.ts";
import { askQuestion, claimWake, pageClaim, PAGE, QUEUE, readClaims, recordAnswerDelivered, recoverClaims, type Answer, type Question } from "./questions.ts";

const HOUR = 3600_000, DAY = 24 * HOUR;
const AGES = [["25 hours", 25 * HOUR], ["8 days", 8 * DAY], ["40 days", 40 * DAY]] as const;

const rig = (status = () => 202) => {
	const store = memStore();
	const wake = recordingWake(status);
	const ready = { now: true };
	const clock = { t: Date.parse("2026-11-12T12:00:00Z") };
	const alarms: string[] = [];
	const logs: string[] = [];
	const relay = createRelay({
		store, lock: testRelayLock(store), wake: { ready: () => ready.now, send: wake.wake.send }, gate: () => "idle", log: (e) => logs.push(e), alarm: (k) => alarms.push(k), now: () => clock.t,
		retryAfterMs: () => 0, onDelivered: (id) => recordAnswerDelivered(store, id),
	});
	return { store, wake, ready, clock, alarms, logs, relay };
};

describe("an undelivered wake in the outbox", () => {
	for (const [name, age] of AGES) {
		test(`${name} old: the relay sends it on its next pass, not dropped`, async () => {
			const r = rig();
			r.store.wakes.enqueue({ deliveryId: "sweep:1", message: "[chamberlain] sweep: the disk is full", queuedAt: r.clock.t - age });
			expect(await r.relay.pass()).toEqual(["sweep:1"]);
			expect(r.wake.accepted.map((w) => w.deliveryId)).toEqual(["sweep:1"]);
			expect(r.store.wakes.isDelivered("sweep:1")).toBe(true);
		});
	}

	test("with nowhere to send it is kept through 25 hours, 8 days and 40 days with no attempt used, raises wake-stale, and goes once when it can", async () => {
		const r = rig();
		r.ready.now = false;
		r.store.wakes.enqueue({ deliveryId: "t1:needs_input:r1:1", message: "[chamberlain] needs_input: thread X", queuedAt: r.clock.t });
		for (const [, age] of AGES) {
			r.clock.t += age;
			expect(await r.relay.pass()).toEqual([]);
			r.relay.audit();
			maintain(r.store, r.clock.t);
			expect(r.store.wakes.rows().map((w) => w.deliveryId)).toEqual(["t1:needs_input:r1:1"]);
		}
		expect(r.alarms).toContain("wake-stale");
		expect(r.logs).toContain("deliver-stale");
		r.ready.now = true;
		expect(await r.relay.pass()).toEqual(["t1:needs_input:r1:1"]);
		expect(r.wake.accepted).toHaveLength(1);
	});

	test("a wake the transport keeps refusing is a dead letter after three attempts, and it is kept through 40 days, never pruned", async () => {
		const r = rig(() => 503);
		r.store.wakes.enqueue({ deliveryId: "d1", message: "m", queuedAt: r.clock.t });
		for (let i = 0; i < 4; i++) await r.relay.pass();
		expect(r.store.wakes.find("d1")).toMatchObject({ status: "dead_letter", attempts: 3 });
		r.clock.t += 40 * DAY;
		maintain(r.store, r.clock.t);
		expect(r.store.wakes.find("d1")!.status).toBe("dead_letter");
		expect(r.alarms).toContain("wake-dead-letter");
	});
});

describe("a held wake", () => {
	for (const [name, age] of AGES) {
		test(`${name} old: it goes out in the next digest, not dropped`, async () => {
			const r = rig();
			r.store.wakes.hold({ deliveryId: "turn:A:1", message: "[chamberlain] turn_ended: A finished", queuedAt: r.clock.t - age, kind: "turn_ended", thread: "A" });
			expect(await r.relay.pass()).toEqual(["turn:A:1"]);
			expect(r.wake.accepted).toHaveLength(1);
			expect(r.wake.accepted[0]!.message).toContain("A finished");
			expect(r.store.wakes.held()).toEqual([]);
		});
	}
});

const item = (id: string): Question => ({ id, kind: "product", title: "Photo first?", context: "ctx", options: [{ label: "Yes" }, { label: "No" }], thread: "Mobile", server: "main", createdAt: "2026-09-01T00:00:00.000Z" });
const answered = (r: ReturnType<typeof rig>, id: string, age: number) => {
	askQuestion(r.store, item(id), r.clock.t - age);
	const a: Answer = { choice: 0, label: "Yes", by: "page", t: new Date(r.clock.t - age).toISOString(), deliveryId: `answer:item:${id}` };
	claimWake(r.store, pageClaim(item(id), a));
};

describe("a page claim whose wake was never delivered", () => {
	for (const [name, age] of AGES) {
		test(`${name} old: recovery sends it, however old`, async () => {
			const r = rig();
			answered(r, "Q-old01", age);
			expect((await recoverClaims({ store: r.store, owns: (o) => o === PAGE, log: () => {} })).sent).toEqual(["Q-old01"]);
			await r.relay.pass();
			expect(r.wake.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-old01"]);
			expect(r.store.items.get(QUEUE, "Q-old01")?.status).toBe("resolved");
		});
	}
});

describe("retention prunes only terminal rows", () => {
	test("100 days on, every kind of undelivered work is still there, and a finished delivery is gone", () => {
		const r = rig();
		const now = r.clock.t + 100 * DAY;
		const longAgo = r.clock.t - 40 * DAY;
		// Undelivered work, all older than any retention window.
		r.store.wakes.enqueue({ deliveryId: "outbox-1", message: "m", queuedAt: longAgo });
		r.store.wakes.hold({ deliveryId: "held-1", message: "m", queuedAt: longAgo, kind: "sweep" });
		answered(r, "Q-open1", 40 * DAY);
		askQuestion(r.store, item("Q-open2"), longAgo);
		// Terminal rows: a delivery nobody names any more, and a question that finished.
		deliveredRow(r.store, "finished-1", longAgo);
		r.store.wakes.enqueue({ deliveryId: "cancelled-1", message: "m", queuedAt: longAgo });
		r.store.wakes.cancel("cancelled-1", longAgo);
		askQuestion(r.store, item("Q-done1"), longAgo);
		r.store.items.resolve(QUEUE, "Q-done1", longAgo);

		maintain(r.store, now);

		expect(r.store.wakes.rows("all").map((w) => w.deliveryId)).toEqual(["outbox-1"]);
		expect(r.store.wakes.held().map((h) => h.deliveryId)).toEqual(["held-1"]);
		expect(readClaims(r.store).map((c) => c.item)).toEqual(["Q-open1"]);
		expect(r.store.items.get(QUEUE, "Q-open1")?.status).toBe("triggered");
		expect(r.store.items.get(QUEUE, "Q-open2")?.status).toBe("triggered");
		// The finished rows are gone; their ids are not (migration 7's tombstones), so neither can be queued again.
		expect(r.store.wakes.isDelivered("finished-1")).toBe(true);
		expect(r.store.wakes.enqueue({ deliveryId: "finished-1", message: "again", queuedAt: now })).toBe(false);
		expect(r.store.wakes.enqueue({ deliveryId: "cancelled-1", message: "again", queuedAt: now })).toBe(false);
		expect(r.store.items.get(QUEUE, "Q-done1")).toBeDefined(); // the queue's own answers are history and stay
		expect(ITEM_KEEP_MS).toBeGreaterThan(0);
	});

	test("the delivery of an unresolved claim outlives the 30 days, so the old claim cannot go out a second time", async () => {
		const r = rig();
		answered(r, "Q-late1", 40 * DAY);
		// The wake was accepted 40 days ago, and the process died before it marked the question delivered.
		deliveredRow(r.store, "answer:item:Q-late1", r.clock.t - 40 * DAY);
		maintain(r.store, r.clock.t);
		expect(r.store.wakes.isDelivered("answer:item:Q-late1")).toBe(true);
		const sent: string[] = [];
		await recoverClaims({ store: r.store, owns: (o) => o === PAGE, log: () => {}, delivered: (c) => recordAnswerDelivered(r.store, c.deliveryId), send: async (c) => { sent.push(c.item); } });
		expect(sent).toEqual([]);
		expect(r.wake.accepted).toEqual([]);
		expect(r.store.items.get(QUEUE, "Q-late1")?.status).toBe("resolved");
	});
});

/**
 * Active hold: a question card in a thread the principal is writing in waits for them (`activeHold.windowMinutes`) before it wakes the Steward.
 * Every test runs on the engine's injected clock (`r.clock`), never the real one.
 */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, question } = useCoreEngineFixtures(createEngine);
const MIN = 60_000;
const ON = { enabled: true, windowMs: 5 * MIN };
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));
const logged = (r: ReturnType<typeof rig>, event: string) => r.events.filter((e) => e.event === event);

/** A card raised in thread `id`; the principal last wrote there `agoMin` minutes before the clock (never, when undefined). */
function card(r: ReturnType<typeof rig>, id: string, agoMin: number | undefined, req = "req-1") {
	r.fake.threads.set(id, {
		waiting: [{ ...question, requestId: req }],
		...(agoMin === undefined ? {} : { principalAt: r.clock.t - agoMin * MIN }),
	});
	r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
}
/** The card is answered in the thread: it waits on nothing now. */
function answer(r: ReturnType<typeof rig>, id: string, req = "req-1") {
	r.fake.threads.set(id, { ...r.fake.threads.get(id), waiting: [], resolved: [req] });
	r.fake.emit({ kind: "state", thread: thread(id, "running") });
}

describe("a card in a thread the principal is writing in", () => {
	test("is held, then dropped when the principal answers it inside the window: no wake", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		expect(posts(r)).toEqual([]);
		expect(r.store.wakes.rows("all")).toEqual([]);
		expect(logged(r, "active-hold-held")).toHaveLength(1);
		answer(r, "t1");
		r.clock.t += 5 * MIN;
		await r.engine.tick();
		await r.until("the drop", () => logged(r, "active-hold-dropped").length === 1);
		expect(logged(r, "active-hold-dropped")[0]!.reason).toBe("answered");
		expect(r.store.wakes.parked()).toEqual([]);
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		expect(r.store.wakes.rows("all")).toEqual([]);
	});

	test("is held, then wakes the Steward at the due time when it is still unanswered, saying why", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		const due = r.store.wakes.parked()[0]!.parked!.releaseAt;
		expect(due).toBe(r.clock.t - MIN + 5 * MIN);
		// One millisecond before the due time nothing moves.
		r.clock.t = due - 1;
		await r.engine.tick();
		await r.quiet();
		expect(posts(r)).toEqual([]);
		expect(r.store.wakes.parked()).toHaveLength(1);
		r.clock.t = due;
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
		const w = posts(r)[0]!;
		expect(w.message.split("\n")[0]).toBe(
			'[chamberlain] needs_input: thread "Thread t1" is waiting for your answer or approval.',
		);
		expect(w.message).toContain("they wrote in this thread at");
		expect(w.message).toContain("it is still unanswered");
		expect(w.message).toContain("Answer it under your decision rights, or queue it as a Decision");
		expect(w.message).toContain("Merge now?");
		expect(w.deliveryId).toContain("t1:needs_input:req-1");
		expect(r.store.wakes.parked()).toEqual([]);
		expect(logged(r, "active-hold-released")[0]).toMatchObject({ reason: "due" });
	});

	test("a thread the principal has not written in wakes the Steward at once, as before", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", undefined);
		await r.until("the wake", () => posts(r).length === 1);
		expect(posts(r)[0]!.message).not.toContain("Held for");
		expect(r.store.wakes.parked()).toEqual([]);
		expect(logged(r, "active-hold-held")).toEqual([]);
	});

	test("a message older than the window is not activity", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 6);
		await r.until("the wake", () => posts(r).length === 1);
		expect(r.store.wakes.parked()).toEqual([]);
	});

	test("while the principal is away the card wakes the Steward at once", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		r.store.away.enter({ enteredAt: new Date(r.clock.t).toISOString(), words: "out for a bit" });
		card(r, "t1", 1);
		await r.until("the wake", () => posts(r).length === 1);
		expect(r.store.wakes.parked()).toEqual([]);
	});

	test("going away releases a parked card at once, before its time", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		r.store.away.enter({ enteredAt: new Date(r.clock.t).toISOString(), words: "heading out" });
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
		expect(logged(r, "active-hold-released")[0]).toMatchObject({ reason: "away" });
	});

	test("with the feature off (enabled: false, or no config) it wakes at once", async () => {
		for (const activeHold of [{ enabled: false, windowMs: 5 * MIN }, undefined]) {
			const r = rig({ steward: "steward-1", ...(activeHold ? { activeHold } : {}) });
			card(r, "t1", 1);
			await r.until("the wake", () => posts(r).length === 1);
			expect(r.store.wakes.parked()).toEqual([]);
		}
	});

	test("fail open: a read that errors (server down, auth) wakes the Steward at once and logs why", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		r.fake.threads.set("t1", { waiting: [{ ...question, requestId: "req-1" }], principalAt: "error" });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => posts(r).length === 1);
		expect(posts(r)[0]!.message).not.toContain("Held for");
		expect(r.store.wakes.parked()).toEqual([]);
		expect(logged(r, "active-hold-unavailable")).toHaveLength(1);
		expect(logged(r, "active-hold-unavailable")[0]!.server).toBe("fake");
	});

	test("fail open: a read that never answers is given up on after the read deadline, and the card wakes at once", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON, activeHoldReadMs: 30 });
		r.fake.threads.set("t1", { waiting: [{ ...question, requestId: "req-1" }], principalAt: "hang" });
		const t0 = Date.now();
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => posts(r).length === 1);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(r.store.wakes.parked()).toEqual([]);
		expect(logged(r, "active-hold-unavailable")).toHaveLength(1);
		expect(String(logged(r, "active-hold-unavailable")[0]!.error)).toContain("timeout");
	});

	test("answered before its due time: dropped at the next tick, not at the due time", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		// Unanswered and not due: the tick leaves it parked.
		await r.engine.tick();
		expect(r.store.wakes.parked()).toHaveLength(1);
		answer(r, "t1");
		await r.engine.tick();
		await r.until("the early drop", () => logged(r, "active-hold-dropped").length === 1);
		expect(logged(r, "active-hold-dropped")[0]!.reason).toBe("answered");
		expect(r.store.wakes.parked()).toEqual([]);
		expect(r.fake.wakes).toEqual([]);
	});

	test("a card whose thread was settled while it waited is dropped, not sent", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		r.fake.emit({ kind: "state", thread: thread("t1", "completed", { archived: true }) });
		r.clock.t += 5 * MIN;
		await r.engine.tick();
		await r.until("the drop", () => logged(r, "active-hold-dropped").length === 1);
		expect(logged(r, "active-hold-dropped")[0]!.reason).toBe("left");
		expect(r.fake.wakes).toEqual([]);
	});

	test("a window of the operator's choosing (activeHold.windowMinutes) moves the due time", async () => {
		const r = rig({ steward: "steward-1", activeHold: { enabled: true, windowMs: 2 * MIN } });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		expect(r.store.wakes.parked()[0]!.parked!.releaseAt).toBe(r.clock.t - MIN + 2 * MIN);
	});
});

describe("a parked card survives a restart", () => {
	const parkedRow = (releaseAt: number, queuedAt: number) => ({
		deliveryId: "t1:input:req-1:1",
		message:
			'[chamberlain] needs_input: thread "Thread t1" is waiting for your answer or approval.\nthreadId: t1  (top-level)',
		queuedAt,
		kind: "needs_input",
		thread: "t1",
		parked: { releaseAt, lastWriteAt: queuedAt, server: "fake", requestIds: ["req-1"] },
	});

	test("a card past its due time on boot is released at once, never lost", async () => {
		const store = memStore();
		const now = Date.now();
		expect(store.wakes.hold(parkedRow(now - 30 * MIN, now - 35 * MIN))).toBe(true);
		const r = rig({ store, steward: "steward-1", activeHold: ON });
		await r.until("the wake", () => posts(r).length === 1);
		expect(posts(r)[0]!.deliveryId).toBe("t1:input:req-1:1");
		expect(posts(r)[0]!.message).toContain("they wrote in this thread at");
		expect(store.wakes.parked()).toEqual([]);
	});

	test("a card not yet due on boot stays parked until its time", async () => {
		const store = memStore();
		const now = Date.now();
		store.wakes.hold(parkedRow(now + 3 * MIN, now - 2 * MIN));
		const r = rig({ store, steward: "steward-1", activeHold: ON });
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		expect(store.wakes.parked()).toHaveLength(1);
		r.clock.t = now + 3 * MIN;
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
	});
});

describe("what is never held", () => {
	test("a parked card is not folded into a digest of held news, and does not hold it back", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", 1);
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		r.engine.outbox.deliver("a note from t2", "t2:note:1", { kind: "note", thread: "t2" });
		await r.engine.tick();
		await r.until("the note", () => posts(r).some((w) => w.deliveryId === "t2:note:1"));
		expect(r.store.wakes.parked()).toHaveLength(1);
		expect(posts(r).every((w) => !w.message.includes("Merge now?"))).toBe(true);
	});
});

/**
 * Active hold, audit round 1: a card is dropped only on positive evidence, every read in the hold path has a deadline, one card never holds up
 * another, and a parked record that cannot be read is released at once.
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
function card(r: ReturnType<typeof rig>, id: string, req: string) {
	r.fake.threads.set(id, { waiting: [{ ...question, requestId: req }], principalAt: r.clock.t - MIN });
	r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
}

describe("a card is dropped only on positive evidence", () => {
	test("a card missing from a bounded read (not waiting, not resolved) is released at its time, never dropped as answered", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", "req-1");
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		// T3's snapshot no longer shows the card either way: it is a window of the thread's recent history.
		r.fake.threads.set("t1", { ...r.fake.threads.get("t1"), waiting: [], resolved: [] });
		await r.engine.tick();
		expect(r.store.wakes.parked()).toHaveLength(1);
		r.clock.t += 5 * MIN;
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
		expect(logged(r, "active-hold-dropped")).toEqual([]);
		expect(posts(r)[0]!.message).toContain("it is still unanswered");
	});

	test("a card shown resolved is dropped, and says answered", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		card(r, "t1", "req-1");
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		r.fake.threads.set("t1", { ...r.fake.threads.get("t1"), waiting: [], resolved: ["req-1"] });
		await r.engine.tick();
		await r.until("the drop", () => logged(r, "active-hold-dropped").length === 1);
		expect(logged(r, "active-hold-dropped")[0]!.reason).toBe("answered");
	});
});

describe("every read in the hold path has a deadline, and cards are settled independently", () => {
	test("a release read that never answers releases that card after the deadline, and does not hold up another card or the next tick", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON, activeHoldReadMs: 40 });
		card(r, "hung", "req-h");
		card(r, "done", "req-d");
		await r.until("both parked", () => r.store.wakes.parked().length === 2);
		r.fake.threads.set("hung", { ...r.fake.threads.get("hung"), waitingHang: true });
		r.fake.threads.set("done", { ...r.fake.threads.get("done"), waiting: [], resolved: ["req-d"] });
		r.clock.t += 5 * MIN;
		const t0 = Date.now();
		const first = r.engine.tick();
		// The answered card is dropped at once, while the other read is still out.
		await r.until("the other card is dropped", () => logged(r, "active-hold-dropped").length === 1);
		expect(Date.now() - t0).toBeLessThan(40 + 500);
		await first;
		await r.until("the hung card's wake", () => posts(r).length === 1);
		expect(posts(r)[0]!.message).toContain('thread "Thread hung"');
		expect(logged(r, "active-hold-unavailable").some((e) => e.threadId === "hung")).toBe(true);
		expect(r.store.wakes.parked()).toEqual([]);
		// The next tick is not stuck behind the hung read.
		await r.engine.tick();
	});

	test("a card whose release read hangs while it is not yet due stays parked, and the tick still returns", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON, activeHoldReadMs: 40 });
		card(r, "hung", "req-h");
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		r.fake.threads.set("hung", { ...r.fake.threads.get("hung"), waitingHang: true });
		await r.engine.tick();
		expect(r.store.wakes.parked()).toHaveLength(1);
		expect(r.fake.wakes).toEqual([]);
	});
});

describe("a parked record that cannot be read", () => {
	test("is released at once on boot, never stuck in neither list", async () => {
		const store = memStore();
		const now = Date.now();
		store.wakes.hold({
			deliveryId: "t1:input:req-1:1",
			message:
				'[chamberlain] needs_input: thread "Thread t1" is waiting for your answer or approval.\nthreadId: t1  (top-level)',
			queuedAt: now - MIN,
			kind: "needs_input",
			thread: "t1",
			parked: { releaseAt: Number.POSITIVE_INFINITY, lastWriteAt: now - MIN, server: "fake", requestIds: ["req-1"] },
		});
		const r = rig({ store, steward: "steward-1", activeHold: ON });
		await r.until("the wake", () => posts(r).length === 1);
		expect(store.wakes.parked()).toEqual([]);
	});
});

/**
 * Active hold, round 2: a released group of cards is split per card, each routed or dropped on its OWN evidence (a card missing from the bounded
 * snapshot is never dropped), and a card held for the principal's return is either held or the Steward's, in one transaction: a pointer post that
 * times out is retried, never turned into a second notification.
 */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, question } = useCoreEngineFixtures(createEngine);
const MIN = 60_000;
const ON = { enabled: true, windowMs: 5 * MIN };
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));
const approval = { type: "approval_request" as const, requestId: "req-a", label: "Run the migration", questions: [] };
const ask = { ...question, requestId: "req-q" };

/** Two cards raised together in one thread, so one wake is parked for both. */
async function parkedGroup(r: ReturnType<typeof rig>) {
	r.fake.threads.set("t1", { waiting: [approval, ask], principalAt: r.clock.t - MIN });
	r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-a" }) });
	await r.until("the group is parked", () => r.store.wakes.parked().length === 1);
	expect(r.store.wakes.parked()[0]!.parked!.requestIds.sort()).toEqual(["req-a", "req-q"]);
}
const awayNow = (r: ReturnType<typeof rig>) =>
	r.store.away.enter({ enteredAt: new Date(r.clock.t).toISOString(), words: "heading out" });
const heldThreads = (r: ReturnType<typeof rig>) => heldOpen(r.store).map((h) => h.threadId ?? h.card?.threadId);

describe("a released group is split per card", () => {
	test("the approval is held for the principal's return; the question, missing from the snapshot, still wakes the Steward", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		await parkedGroup(r);
		// The bounded snapshot now shows only the approval: the question is absent, not resolved.
		r.fake.threads.set("t1", { ...r.fake.threads.get("t1"), waiting: [approval], resolved: [] });
		awayNow(r);
		await r.engine.tick();
		await r.until("the Steward's wake", () => posts(r).length === 1);
		await r.until("the approval held", () => heldThreads(r).includes("t1"));
		expect(posts(r)[0]!.message).toContain("Merge now?");
		expect(posts(r)[0]!.message).toContain("1 of its cards are held for the principal's return");
		expect(r.store.wakes.parked()).toEqual([]);
		expect(r.events.filter((e) => e.event === "held-by-daemon")).toHaveLength(1);
	});

	test("the approval held, the question shown resolved: every card accounted for, nothing wakes the Steward", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		await parkedGroup(r);
		r.fake.threads.set("t1", { ...r.fake.threads.get("t1"), waiting: [approval], resolved: ["req-q"] });
		awayNow(r);
		await r.engine.tick();
		await r.until("the drop", () => r.events.some((e) => e.event === "active-hold-dropped"));
		expect(r.events.find((e) => e.event === "active-hold-dropped")).toMatchObject({ reason: "held-for-return" });
		expect(heldThreads(r)).toContain("t1");
		expect(r.fake.wakes).toEqual([]);
		expect(r.store.wakes.parked()).toEqual([]);
	});

	test("nothing is held or dropped on another card's evidence: the approval missing, the question resolved, wakes the Steward", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		await parkedGroup(r);
		r.fake.threads.set("t1", { ...r.fake.threads.get("t1"), waiting: [], resolved: ["req-q"] });
		awayNow(r);
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
		expect(heldOpen(r.store)).toEqual([]);
	});
});

describe("a held card is either held or the Steward's, in one transaction", () => {
	test("a pointer post that times out is retried, and never releases a Steward wake as well", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON, activeHoldReadMs: 40 });
		r.fake.threads.set("t1", { waiting: [approval], principalAt: r.clock.t - MIN });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-a" }) });
		await r.until("the card is parked", () => r.store.wakes.parked().length === 1);
		awayNow(r);
		r.fake.postHangs = 1;
		await r.engine.tick();
		await r.until("the pointer post, on retry", () => r.fake.posted.length >= 1);
		expect(heldThreads(r)).toContain("t1");
		expect(r.events.filter((e) => e.event === "held-by-daemon")).toHaveLength(1);
		await r.quiet(120);
		expect(r.fake.wakes).toEqual([]);
		expect(r.store.wakes.rows("all")).toEqual([]);
		expect(r.store.wakes.parked()).toEqual([]);
	});
});

/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { askQuestion } from "../items/questions.ts";
import { claimWake, pageClaim } from "../items/questions-claim.ts";
import { appendHeld, heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned, question, flaky } = useCoreEngineFixtures(
	// The daemon's default: the rights ride inside an unstamped sweep, so it is still one wake.
	(d) => createEngine({ ...d, relay: { ...d.relay, rightsInline: true } }),
);

describe("the held ledger is reconciled on the heartbeat", () => {
	test("a tick closes the holds of an answered question, a merged PR and a settled thread, and leaves the rest", async () => {
		const gh = async (path: string) =>
			path.endsWith("/pulls/962") ? { state: "closed", merged_at: "2026-11-13T12:50:41Z" } : { state: "open" };
		const r = rig({ housekeeping: true, gh });
		await r.until("connected", () => r.fake.connected);
		const q = {
			id: "Q-tick1",
			kind: "only-you" as const,
			title: "t",
			context: "",
			options: [{ label: "Yes" }],
			thread: "T",
			server: "fake",
			createdAt: "2026-11-13T00:00:00.000Z",
		};
		askQuestion(r.store, q);
		const at = new Date("2026-11-13T01:00:00.000Z");
		appendHeld(r.store, { thread: "answered", what: "waits", item: "Q-tick1" }, at);
		appendHeld(r.store, { thread: "merged", what: "waits", ref: { pr: "o/r#962" } }, at);
		appendHeld(r.store, { thread: "open-pr", what: "waits", ref: { pr: "o/r#963" } }, at);
		appendHeld(r.store, { thread: "settled", what: "waits", ref: { threadId: "th-settled" } }, at);
		appendHeld(r.store, { thread: "prose", what: "merge o/r#962 for me" }, at);
		claimWake(
			r.store,
			pageClaim(q, {
				choice: 0,
				label: "Yes",
				by: "page",
				t: "2026-11-13T02:00:00.000Z",
				deliveryId: "answer:item:Q-tick1",
			}),
		);
		r.fake.emit({ kind: "state", thread: thread("th-settled", "completed", { settled: true }) });
		await r.until("the thread is known", () => r.engine.watchers[0]!.states.has("th-settled"));
		await r.engine.tick();
		expect(
			heldOpen(r.store)
				.map((h) => h.thread)
				.sort(),
		).toEqual(["open-pr", "prose"]);
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
		expect(r.events.some((e) => e.event === "held-reconciled")).toBe(true);
	});

	// Fix 1. Must fail on 2845f33: the watcher's cache said settled and the hold closed while the server could not be reached.
	test("fix 1: with the server unreachable, a thread the watcher's cache calls settled closes nothing", async () => {
		const r = rig({ housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		appendHeld(
			r.store,
			{ thread: "cached-settled", what: "waits", ref: { threadId: "th-settled" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		r.fake.emit({ kind: "state", thread: thread("th-settled", "completed", { settled: true }) });
		await r.until("the cache has it", () => r.engine.watchers[0]!.states.get("th-settled")?.settled === true);
		r.fake.snapshotError = "connect ECONNREFUSED";
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread)).toEqual(["cached-settled"]);
		r.fake.snapshotError = undefined;
		r.fake.snapshotComplete = false;
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread)).toEqual(["cached-settled"]);
	});

	test("fix 1: a thread its named server no longer lists is gone, and the hold closes from a fresh snapshot; one naming no server stays", async () => {
		const r = rig({ housekeeping: true, capabilities: ["snapshot"] });
		await r.until("connected", () => r.fake.connected);
		appendHeld(
			r.store,
			{ thread: "deleted", what: "waits", server: "fake", ref: { threadId: "th-deleted" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		appendHeld(
			r.store,
			{ thread: "listed", what: "waits", server: "fake", ref: { threadId: "th-listed" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		appendHeld(
			r.store,
			{ thread: "unnamed", what: "waits", ref: { threadId: "th-deleted" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		r.fake.emit({ kind: "state", thread: thread("th-listed", "running") });
		await r.engine.tick();
		expect(
			heldOpen(r.store)
				.map((h) => h.thread)
				.sort(),
		).toEqual(["listed", "unnamed"]);
	});

	test("fix 1: an adapter that cannot take a snapshot leaves its threads unknown", async () => {
		const r = rig({ housekeeping: true, capabilities: [] });
		await r.until("connected", () => r.fake.connected);
		appendHeld(
			r.store,
			{ thread: "h", what: "waits", ref: { threadId: "th-gone" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		await r.engine.tick();
		expect(heldOpen(r.store)).toHaveLength(1);
	});
});

describe("the engine's own dedupe is the item system's", () => {
	test("a wake that went out is a notification-log item, notified once, and an alarm is an item that notifies once per repeat interval", async () => {
		const r = rig();
		r.fake.threads.set("t1", { lastMessage: "Which one?", waiting: [question] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.store.items.get("notification-log", "req:fake:req-1")).toMatchObject({
			kind: "sent",
			status: "triggered",
			notificationCount: 1,
		});
		expect(r.engine.notified().has("req:fake:req-1")).toBe(true);
		r.engine.alarm("steward-stalled", "stalled", "it is");
		r.engine.alarm("steward-stalled", "stalled", "it is");
		expect(r.events.filter((e) => e.event === "alarm")).toHaveLength(1);
		expect(r.store.items.get("alarm", "steward-stalled")).toMatchObject({
			kind: "alarm",
			status: "triggered",
			notificationCount: 1,
		});
		expect(r.store.items.get("alarm", "steward-stalled")!.nextNotificationAt).toBeGreaterThan(Date.now());
	});
});

describe("the Steward's own upkeep goes through the probe and the compaction transport", () => {
	test("past the size limit a compaction is sent once, with the rights re-sent after it", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000 });
		r.fake.probe = { readable: true, contextTokens: 5000 };
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
		expect(r.fake.compactions[0]).toMatch(/^compact:steward-1:\d+$/);
		// The cooldown keeps the next heartbeat from sending another.
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
	});

	test("a compaction the probe says must not go is not sent, and a stalled Steward raises its alarm", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000 });
		r.fake.probe = {
			readable: true,
			contextTokens: 5000,
			compactBlocked: "one is already queued or running",
			stalled: { title: "The Steward has stopped taking wakes", summary: "2 wakes queued" },
		};
		await r.engine.tick();
		expect(r.fake.compactions).toEqual([]);
		expect(r.events.find((e) => e.event === "skip-compact")).toMatchObject({
			reason: "one is already queued or running",
		});
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-stalled")).toBeDefined();
	});

	test("with no compaction capability the size limit only raises an alarm", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000, capabilities: ["stewardProbe"] });
		r.fake.probe = { readable: true, contextTokens: 5000 };
		await r.engine.tick();
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-compact")).toBeDefined();
	});

	test("a probe that can't read the Steward five times running raises the blind alarm", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: false };
		for (let n = 0; n < 5; n++) await r.engine.tick();
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-queue-unreadable")).toBeDefined();
	});
});

describe("an alert is never recorded as sent without its wake (a crash between the two loses nothing)", () => {
	test("a daemon wake: when the outbox row cannot be written, the notification is not recorded either, and the same event wakes the Steward once the disk is back", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap });
		r.fake.threads.set("t1", { lastMessage: "stuck", waiting: [question] });
		fail.at = "enqueue";
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		// Nothing of the decision survives: no notification-log item for the request or the event, and no wake queued.
		expect(r.engine.notified().size).toBe(0);
		expect(r.store.wakes.rows()).toEqual([]);
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Merge now?");
		expect([...r.engine.notified()].sort()).toEqual(expect.arrayContaining(["req:fake:req-1"]));
		expect(r.store.wakes.rows()).toEqual([]);
	});

	test("a held turn end: the same, through the held store", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, steward: "steward-1" });
		const ended = () => {
			r.fake.threads.set("t9", {
				instruction: { items: [{ ...stewardSigned, id: "s-t9" }], state: "complete", byMachine: false },
				lastMessage: "t9 finished the work.",
			});
			r.fake.emit({ kind: "state", thread: thread("t9", "running") });
			r.fake.emit({ kind: "state", thread: thread("t9", "completed") });
		};
		fail.at = "held-push";
		ended();
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		// Neither the report's record nor the turn's own key was written: the next turn end is still news.
		expect(r.engine.notified().size).toBe(0);
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		ended();
		await r.until("the wake", () =>
			r.fake.wakes.some(
				(w) =>
					!w.deliveryId.includes(":rights-first:") &&
					w.message.includes('thread "Thread t9" finished a turn on the work you sent it and has gone quiet.'),
			),
		);
		expect(
			r.fake.wakes.some((w) =>
				w.message.includes('thread "Thread t9" finished a turn on the work you sent it and has gone quiet.'),
			),
		).toBe(true);
	});

	test("a sweep finding: when the wake cannot be queued, the finding is not recorded as notified and the clock does not move, so the next sweep wakes with it", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, housekeeping: true });
		r.priv(
			"sweep.json",
			JSON.stringify({
				checks: [
					{
						name: "disk",
						command: ["/bin/echo", JSON.stringify([{ dedupKey: "root", text: "the root disk is 97% full" }])],
					},
				],
			}),
		);
		fail.at = "held-push";
		await r.engine.tick();
		expect(r.events.some((e) => e.event === "sweep-error")).toBe(true);
		expect(r.store.items.get("check:disk", "root")).toBeUndefined();
		expect(r.store.state.get("sweep-clock")).toMatchObject({ seeded: false });
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		await r.engine.tick();
		await r.until("the sweep wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("the root disk is 97% full");
		expect(r.store.items.get("check:disk", "root")).toMatchObject({ status: "triggered", notificationCount: 1 });
		expect(r.store.state.get("sweep-clock")).toMatchObject({ seeded: true });
		// And it stays quiet afterwards: one notification, one wake.
		await r.engine.tick();
		await r.quiet();
		expect(r.fake.wakes).toHaveLength(1);
	});
});

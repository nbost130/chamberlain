/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineExtraFixtures } from "../../testing/core-engine-extra-fixtures.ts";
import { createEngine } from "./engine.ts";

const { thread, idleRig } = useCoreEngineExtraFixtures(createEngine);

describe("an alert is never recorded as sent without its wake (a crash between the two loses nothing)", () => {
	describe("the idle-parents timer: its own schedule, apart from the routine sweep", () => {
		test("idle top-level threads reach the Steward, asks first, and the rest are filtered out", async () => {
			const { r, ago, seen } = idleRig();
			// The real miss: it ended on a go-phrase, with no card and no open PR.
			seen(
				"ask",
				"idle",
				{},
				ago(240, "The token is in.\n\n🗣️ The breaker still needs its endpoint; say go and I'll start it."),
			);
			seen("plain", "completed", {}, ago(120, "Finished the report."));
			seen("fresh", "idle", {}, ago(10, "Just now."));
			seen("edge", "idle", {}, ago(29, "Just under the threshold."));
			seen("child", "idle", { parentThreadId: "ask" });
			seen("settled", "idle", { settled: true });
			seen("snoozed", "idle", { snoozed: true });
			seen("working", "running", {});
			seen("stew", "idle", {});
			await r.quiet();
			await r.engine.tick();
			await r.until("the idle wake", () => r.fake.wakes.length === 1);
			const msg = r.fake.wakes[0]!.message;
			expect(msg).toContain("[chamberlain] idle threads: 2 top-level threads finished and went quiet");
			expect(msg).toContain('[ASKING] thread "Thread ask" on fake (threadId ask), idle 240 min.');
			expect(msg).toContain('thread "Thread plain" on fake (threadId plain), idle 120 min.');
			expect(msg.indexOf("threadId ask")).toBeLessThan(msg.indexOf("threadId plain"));
			for (const id of ["fresh", "edge", "child", "settled", "snoozed", "working", "stew"])
				expect(msg).not.toContain(`threadId ${id})`);
		});

		test("it fires on its own interval, not the routine sweep's, and dedupe holds across ticks", async () => {
			const { r, ago, seen, runs, sweeps, pass } = idleRig();
			seen("ask", "idle", {}, ago(240, "Say go and I'll start it."));
			seen("plain", "completed", {}, ago(120, "Finished the report."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the first wake", () => r.fake.wakes.length === 1);
			expect([runs(), sweeps()]).toEqual([1, 1]);
			// Fourteen minutes later it is not due; a tick does not run it.
			pass(14);
			await r.engine.tick();
			expect([runs(), sweeps()]).toEqual([1, 1]);
			// Sixteen minutes in it is due on its own, while the two-hourly sweep is not. Nothing new: no wake.
			pass(2);
			await r.engine.tick();
			expect([runs(), sweeps()]).toEqual([2, 1]);
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
			// Many more ticks and intervals, the same last messages: still one wake.
			for (let n = 0; n < 4; n++) {
				pass(16);
				await r.engine.tick();
			}
			expect(runs()).toBe(6);
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
			// One thread says something new: the next due tick reports that thread alone.
			r.fake.threads.set("plain", { lastAssistant: ago(40, "Merged it.", "m2") });
			pass(16);
			await r.engine.tick();
			await r.until("the second wake", () => r.fake.wakes.length === 2);
			expect(r.fake.wakes[1]!.message).toContain("Merged it.");
			expect(r.fake.wakes[1]!.message).not.toContain("threadId ask)");
			expect(r.fake.wakes[1]!.message).toContain("1 top-level thread finished");
			// The interval survives a restart: it is the check's own clock in the database.
			expect(r.store.state.get("idle-parents-clock")).toMatchObject({ lastAt: r.clock.t });
		});

		test("a thread the principal started the last turn on is reported too: selection never looks at who instructed it", async () => {
			const { r, ago } = idleRig();
			const principalSaid = (minAgo: number) => ({
				type: "user_message",
				id: "u1",
				text: "what is the state of the migration?",
				createdBy: "user",
				creationSource: "web",
				updatedAt: new Date(r.clock.t - minAgo * 60_000).toISOString(),
			});
			// The answer to the principal's own question, ended on a half-answer, and then nothing for hours.
			r.fake.threads.set("chat", {
				instruction: { items: [principalSaid(200)], state: "complete", byMachine: false },
				lastAssistant: ago(190, "Part of it is done; the rest needs a look at the logs."),
			});
			r.fake.emit({ kind: "state", thread: thread("chat", "idle") });
			// The same thread, answered just over the threshold ago, is reported at 31 minutes and not at 29.
			r.fake.threads.set("recent", {
				instruction: { items: [principalSaid(45)], state: "complete", byMachine: false },
				lastAssistant: ago(31, "Here is the answer."),
			});
			r.fake.emit({ kind: "state", thread: thread("recent", "completed") });
			r.fake.threads.set("justnow", {
				instruction: { items: [principalSaid(35)], state: "complete", byMachine: false },
				lastAssistant: ago(29, "Here is the answer."),
			});
			r.fake.emit({ kind: "state", thread: thread("justnow", "completed") });
			await r.quiet();
			await r.engine.tick();
			await r.until("the idle wake", () => r.fake.wakes.length === 1);
			const msg = r.fake.wakes[0]!.message;
			expect(msg).toContain('thread "Thread chat" on fake (threadId chat), idle 190 min.');
			expect(msg).toContain("(threadId recent), idle 31 min.");
			expect(msg).not.toContain("threadId justnow)");
			// The turn-ended skip for such a thread is untouched: a live chat turn still wakes nobody.
			r.fake.emit({ kind: "state", thread: thread("live", "running") });
			r.fake.threads.set("live", {
				instruction: { items: [principalSaid(1)], state: "complete", byMachine: false },
				lastMessage: "Answered.",
			});
			r.fake.emit({ kind: "state", thread: thread("live", "completed") });
			await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
			expect(r.fake.wakes).toHaveLength(1);
		});

		test("a parent with a running subagent that only the inspector knows of gets no finding and no wake (a review finding)", async () => {
			const { r, ago, runs } = idleRig();
			r.fake.threads.set("parent", { lastAssistant: ago(90, "Handed the work to a subagent."), subagents: 1 });
			r.fake.emit({ kind: "state", thread: thread("parent", "idle") });
			await r.quiet();
			await r.engine.tick();
			await r.quiet();
			expect(runs()).toBe(1);
			expect(r.fake.wakes).toEqual([]);
			expect(r.store.items.list({ source: "check:idle-parents" })).toEqual([]);
			// When the subagent finishes, the same parent is reported at its next run.
			r.fake.threads.set("parent", { lastAssistant: ago(90, "Handed the work to a subagent."), subagents: 0 });
			r.clock.t += 16 * 60_000;
			await r.engine.tick();
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("threadId parent)");
		});

		test("a thread snoozed for one run and back with the same last message is not reported a second time (a review finding)", async () => {
			const { r, ago, seen, pass } = idleRig();
			seen("a", "idle", {}, ago(120, "Say go and I'll start it."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the first wake", () => r.fake.wakes.length === 1);
			for (const snoozed of [true, false, true, false]) {
				pass(16);
				r.fake.emit({ kind: "state", thread: thread("a", "idle", { snoozed }) });
				await r.engine.tick();
			}
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
		});

		test("the interval and the threshold are configurable", async () => {
			const { r, ago, seen, runs, pass } = idleRig({ idleParents: { intervalMinutes: 5, thresholdMinutes: 100 } });
			seen("old", "idle", {}, ago(130, "Old news."));
			seen("mid", "idle", {}, ago(60, "Not idle enough."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("threadId old)");
			expect(r.fake.wakes[0]!.message).not.toContain("threadId mid)");
			pass(4);
			await r.engine.tick();
			expect(runs()).toBe(1);
			pass(1);
			await r.engine.tick();
			expect(runs()).toBe(2);
		});
	});
});

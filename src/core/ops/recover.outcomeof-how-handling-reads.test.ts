/** recover, continued: see recover.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { rig, STREAM, t } from "../../testing/core-recover-fixtures.ts";
import { outcomeOf } from "./recover.ts";
import { DEFAULT_RECOVER_TIMING, judgeBrief, MIN } from "./recover-classify.ts";
import { memoryRecoverStore, type RecoverStore } from "./recover-state.ts";

describe("outcomeOf: how a Handling reads for the wake and the queue", () => {
	const where = { thread: "Thread one", server: "laptop", threadId: "t1" };
	test("a scheduled retry and a duplicate stop the wake", () => {
		expect(outcomeOf({ action: "retry-scheduled", kind: "stream_closed", at: 1 }, where)).toEqual({ stop: true });
		expect(outcomeOf({ action: "duplicate" }, where)).toEqual({ stop: true });
	});
	test("a wake carries its note and nothing else", () => {
		expect(
			outcomeOf({ action: "wake", kind: "auth", note: "not retried automatically: authentication failed" }, where),
		).toEqual({ note: "not retried automatically: authentication failed" });
	});
	test("the breaker stops the wake, and asks only on the failure that tripped it", () => {
		const first = outcomeOf({ action: "breaker", kind: "stream_closed", alarm: true, count: 3 }, where);
		expect(first.stop).toBe(true);
		expect(first.ask).toMatchObject({
			why: "breaker",
			kind: "stream_closed",
			count: 3,
			item: { kind: "only-you", tag: "Outage" },
		});
		expect(outcomeOf({ action: "breaker", kind: "stream_closed", alarm: false, count: 4 }, where)).toEqual({
			stop: true,
		});
	});
	test("a verdict words the failed wake with the judge and what the daemon will do next", () => {
		const o = outcomeOf(
			{
				action: "verdict",
				kind: "provider_turn_failed",
				backend: "small-model",
				verdict: "retry_later",
				reason: "looks transient",
				ask: false,
			},
			where,
		);
		expect(o.what).toBe("run failed twice (provider turn failed) after an automatic retry");
		expect(o.note).toBe(
			"small-model judge: retry later — looks transient. The daemon retries this thread no more until it finishes a turn.",
		);
		expect(o.ask).toBeUndefined();
	});
	test("a verdict that needs the principal also raises a queue item", () => {
		const o = outcomeOf(
			{
				action: "verdict",
				kind: "capacity",
				backend: "small-model",
				verdict: "ask_principal",
				reason: "a different model?",
				ask: true,
			},
			where,
		);
		expect(o.note).toContain("The principal has been asked on the decision queue.");
		expect(o.ask).toMatchObject({ why: "verdict", item: { kind: "only-you", threadId: "t1" } });
	});
	test("an unjudged verdict says the judge could not answer", () => {
		const o = outcomeOf(
			{
				action: "verdict",
				kind: "oom",
				backend: "small-model",
				verdict: "unjudged",
				reason: "small-model judge exited 1",
				ask: false,
			},
			where,
		);
		expect(o.note).toContain("the judge could not answer (small-model judge exited 1)");
	});
});

describe("a thread is read again right before the ping", () => {
	test("a card opened during the reads stops the retry (the state is read after the last await, not before)", async () => {
		const x = rig({
			look: async (id) => {
				/* the read is slow, and a card opens while it runs */ x.states.set(
					id,
					t({ id, latestRunId: "run-1", pendingRequestId: "req-late" }),
				);
				return { latestRunId: "run-1", latestStatus: "failed", active: false, waiting: false };
			},
		});
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.logs.find((l) => l.event === "recover-stand-down")?.data?.why).toMatch(/open card/);
	});
	test("the fresh read shows a card, approval or question open: no ping", async () => {
		const x = rig({
			look: async () => ({ latestRunId: "run-1", latestStatus: "failed", active: false, waiting: true }),
		});
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.logs.find((l) => l.event === "recover-stand-down")?.data?.why).toMatch(/waiting on a card/);
	});
	test("the fresh read shows a run going: no ping", async () => {
		const x = rig({
			look: async () => ({ latestRunId: "run-1", latestStatus: "failed", active: true, waiting: false }),
		});
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
	});
	test("the fresh read shows the newest run completed, or a different run: no ping", async () => {
		for (const look of [
			{ latestRunId: "run-1", latestStatus: "completed", active: false, waiting: false },
			{ latestRunId: "run-2", latestStatus: "failed", active: false, waiting: false },
		]) {
			const x = rig({ look: async () => look });
			await x.fail("t1", { runId: "run-1", ...STREAM });
			await x.advance(4 * MIN);
			expect(x.pings).toEqual([]);
		}
	});
	test("a fresh read that cannot be made sends nothing, and the Steward hears of the failure", async () => {
		const x = rig({ look: async () => undefined });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.wakes).toHaveLength(1);
		expect(x.wakes[0]!.note).toMatch(/could not be read/);
	});
	test("an archived, settled or snoozed thread at ping time is left alone, whatever the cached state said at the failure", async () => {
		for (const over of [{ archived: true }, { settled: true }, { snoozed: true }]) {
			const x = rig();
			await x.fail("t1", { runId: "run-1", ...STREAM });
			x.states.set("t1", t({ latestRunId: "run-1", ...over }));
			await x.advance(4 * MIN);
			expect(x.pings).toEqual([]);
		}
	});
});

describe("recovery state survives a restart", () => {
	test("a retry already sent is not sent again as a first ping: the next failure goes to the judge", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		await a.fail("t1", { runId: "run-1", ...STREAM });
		await a.advance(4 * MIN);
		expect(a.pings).toHaveLength(1);
		a.r.stop();
		const b = rig({ store, share: a });
		expect(await b.fail("t1", { runId: "run-2", ...STREAM })).toMatchObject({ action: "verdict" });
		expect(b.pings).toEqual([]);
		expect(b.judged).toHaveLength(1);
	});
	test("the same run seen again after a restart is a duplicate, not a second first failure", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		await a.fail("t1", { runId: "run-1", ...STREAM });
		a.r.stop();
		const b = rig({ store, share: a });
		expect(await b.fail("t1", { runId: "run-1", ...STREAM })).toEqual({ action: "duplicate" });
	});
	test("a retry still pending when the daemon died is re-armed on restore, and goes once", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		await a.fail("t1", { runId: "run-1", ...STREAM });
		a.r.stop();
		await a.advance(10 * MIN);
		expect(a.pings).toEqual([]);
		const b = rig({ store, share: a });
		b.r.restore();
		expect(b.r.pendingCount()).toBe(1);
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
		expect(b.pings).toHaveLength(1);
		expect(b.pings[0]!.seed).toBe("recover:t1:run-1");
	});
	test("a retry that fell due while down still waits for the watchers (restoreDelayMs), and never fires before it", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		await a.fail("t1", { runId: "run-1", ...STREAM });
		a.r.stop();
		await a.advance(10 * MIN);
		const b = rig({ store, share: a });
		b.r.restore();
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs - 1000);
		expect(b.pings).toEqual([]);
	});
	test("the judge's hold survives a restart: a third failure is not retried", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		await a.fail("t1", { runId: "run-1", ...STREAM });
		await a.advance(4 * MIN);
		await a.fail("t1", { runId: "run-2", ...STREAM });
		a.r.stop();
		const b = rig({ store, share: a });
		await b.advance(11 * MIN);
		expect(await b.fail("t1", { runId: "run-3", ...STREAM })).toMatchObject({
			action: "wake",
			note: expect.stringMatching(/already seen/),
		});
		expect(b.pings).toEqual([]);
	});
	test("a tripped breaker survives a restart: no retry goes out and no second alarm is raised", async () => {
		const store = memoryRecoverStore();
		const a = rig({ store });
		for (const [i, id] of ["a", "b", "c"].entries()) await a.fail(id, { runId: `run-${i + 1}`, ...STREAM });
		expect(a.r.tripped()).toBe(true);
		a.r.stop();
		const b = rig({ store, share: a });
		expect(b.r.tripped()).toBe(true);
		expect(await b.fail("d", { runId: "run-4", ...STREAM })).toMatchObject({ action: "breaker", alarm: false });
	});
	test("a store that cannot save never breaks recovery: nothing is sent without a durable record, and the Steward is told why", async () => {
		const store: RecoverStore = {
			load: () => undefined,
			save: () => {
				throw Error("disk full");
			},
		};
		const x = rig({ store });
		expect((await x.fail("t1", { runId: "run-1", ...STREAM })).action).toBe("retry-scheduled");
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.wakes).toHaveLength(1);
		expect(x.wakes[0]!.note).toMatch(/could not be saved \(disk full\)/);
		expect(x.logs.some((l) => l.event === "recover-state-unsaved")).toBe(true);
		x.r.healthy("t1");
		expect((await x.fail("t1", { runId: "run-2", ...STREAM })).action).toBe("retry-scheduled");
	});
});

describe("failures are counted per thread over a longer horizon", () => {
	test("four failures spread over hours send one ping: the second reaches the judge, the rest are held for the Steward", async () => {
		const x = rig();
		expect((await x.fail("t1", { runId: "run-1", ...STREAM })).action).toBe("retry-scheduled");
		await x.advance(4 * MIN);
		await x.advance(30 * MIN);
		const second = await x.fail("t1", { runId: "run-2", ...STREAM });
		expect(second).toMatchObject({ action: "verdict" });
		await x.advance(45 * MIN);
		const third = await x.fail("t1", { runId: "run-3", ...STREAM });
		expect(third).toMatchObject({ action: "wake", note: expect.stringMatching(/2 failures so far|3 failures so far/) });
		await x.advance(60 * MIN);
		expect((await x.fail("t1", { runId: "run-4", ...STREAM })).action).toBe("wake");
		await x.advance(60 * MIN);
		expect(x.pings).toHaveLength(1);
		expect(x.judged).toHaveLength(1);
	});
	test("failures past the horizon are a new stretch: a thread that failed once a day for a week is retried each time", async () => {
		const x = rig();
		for (let day = 1; day <= 3; day++) {
			expect((await x.fail("t1", { runId: `run-${day}`, ...STREAM })).action).toBe("retry-scheduled");
			await x.advance(4 * MIN);
			x.r.healthy("t1");
			await x.advance(24 * 60 * MIN);
		}
		expect(x.pings).toHaveLength(3);
	});
});

describe("the judge's brief scrubs and caps class and code too", () => {
	test("a class or code carrying a path, an email or a long token reaches the judge scrubbed and clipped", () => {
		const evil = `provider /home/someone/secret a@b.co ${"k".repeat(80)}`;
		const b = judgeBrief(
			"capacity",
			{ runId: "1", class: evil, code: evil, message: "m" },
			{ runId: "2", class: "ok", code: "ok", message: "m" },
			4 * MIN,
		);
		expect(b.user).not.toMatch(/someone|a@b\.co|k{20}/);
		const first = b.user.split("\n").find((l) => l.startsWith("First failure"))!;
		expect(first.length).toBeLessThan(320);
	});
});

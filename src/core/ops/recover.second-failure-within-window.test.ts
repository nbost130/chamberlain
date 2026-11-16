/** recover, continued: see recover.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { rig, STREAM } from "../../testing/core-recover-fixtures.ts";
import { breakerItem, verdictItem } from "./recover.ts";
import { DEFAULT_RECOVER_TIMING, judgeBrief, MIN } from "./recover-classify.ts";

describe("a second failure within the window goes to the judge", () => {
	const retried = async (x: ReturnType<typeof rig>) => {
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toHaveLength(1);
	};

	test("the retry fails: the judge gets both failures and its verdict goes up for the Steward's wake", async () => {
		const x = rig();
		await retried(x);
		const h = await x.fail("t1", { runId: "run-2", message: "The provider event stream closed unexpectedly." });
		expect(h).toMatchObject({
			action: "verdict",
			kind: "stream_closed",
			backend: "small-model",
			verdict: "do_not_retry",
			ask: false,
		});
		expect(x.judged).toHaveLength(1);
		expect(x.judged[0]!.trigger).toBe("stalled-recovery");
		expect(x.judged[0]!.user).toContain("First failure");
		expect(x.judged[0]!.user).toContain("Second failure");
	});

	test("the judge never sees thread text or the thread's title: only the two errors", async () => {
		const x = rig();
		await retried(x);
		await x.fail("t1", { runId: "run-2", message: "boom at /home/someone/secret/path" });
		expect(x.judged[0]!.user).not.toContain("Thread one");
		expect(x.judged[0]!.user).not.toContain("/home/someone");
	});

	test("an ask_principal verdict asks the principal", async () => {
		const x = rig({ judge: () => ({ ok: true, backend: "small-model", verdict: "ask_principal", reason: "a limit" }) });
		await retried(x);
		expect(await x.fail("t1", { runId: "run-2", ...STREAM })).toMatchObject({
			action: "verdict",
			verdict: "ask_principal",
			ask: true,
		});
	});

	test("a judge that cannot answer still hands the failure to the Steward, marked unjudged", async () => {
		const x = rig({ judge: () => ({ ok: false, backend: "small-model", error: "small-model judge exited 1" }) });
		await retried(x);
		expect(await x.fail("t1", { runId: "run-2", ...STREAM })).toMatchObject({
			action: "verdict",
			verdict: "unjudged",
			ask: false,
			reason: "small-model judge exited 1",
		});
	});

	test("the daemon retries that thread no more until it completes a turn", async () => {
		const x = rig();
		await retried(x);
		await x.fail("t1", { runId: "run-2", ...STREAM });
		await x.advance(11 * MIN);
		const h = await x.fail("t1", { runId: "run-3", ...STREAM });
		expect(h).toMatchObject({ action: "wake", note: expect.stringMatching(/already seen this thread fail twice/) });
		await x.advance(30 * MIN);
		expect(x.pings).toHaveLength(1);
		x.r.healthy("t1");
		expect((await x.fail("t1", { runId: "run-4", ...STREAM })).action).toBe("retry-scheduled");
	});

	test("a failure long after the retry (past ten minutes) still goes to the judge: it is not a fresh first failure", async () => {
		const x = rig();
		await retried(x);
		await x.advance(11 * MIN);
		expect(await x.fail("t1", { runId: "run-2", ...STREAM })).toMatchObject({
			action: "verdict",
			verdict: "do_not_retry",
		});
		expect(x.judged).toHaveLength(1);
		expect(x.pings).toHaveLength(1);
	});
});

describe("the outage breaker", () => {
	const stream = (n: number) => ({ runId: `run-${n}`, ...STREAM });

	test("three failures of one kind within ten minutes stop all retries and raise exactly one alarm", async () => {
		const x = rig();
		expect((await x.fail("a", stream(1))).action).toBe("retry-scheduled");
		await x.advance(2 * MIN);
		expect((await x.fail("b", stream(2))).action).toBe("retry-scheduled");
		await x.advance(2 * MIN);
		const third = await x.fail("c", stream(3));
		expect(third).toMatchObject({ action: "breaker", kind: "stream_closed", alarm: true, count: 3 });
		expect(x.r.tripped()).toBe(true);
		expect(x.r.pendingCount()).toBe(0);
		const sent = x.pings.length;
		// While it holds, every further failure is suppressed and none raises a second alarm.
		expect(await x.fail("d", stream(4))).toMatchObject({ action: "breaker", alarm: false });
		await x.advance(5 * MIN);
		expect(await x.fail("e", stream(5))).toMatchObject({ action: "breaker", alarm: false });
		await x.advance(5 * MIN);
		expect(x.pings).toHaveLength(sent);
	});

	test("two failures are not an outage", async () => {
		const x = rig();
		await x.fail("a", stream(1));
		await x.fail("b", stream(2));
		expect(x.r.tripped()).toBe(false);
		await x.advance(4 * MIN);
		expect(x.pings).toHaveLength(2);
	});

	test("failures of different kinds do not add up", async () => {
		const x = rig();
		await x.fail("a", stream(1));
		await x.fail("b", { runId: "run-2", class: "transport_error", message: "Provider turn failed." });
		await x.fail("c", {
			runId: "run-3",
			class: "provider_error",
			code: "api_error_503",
			message: "Claude API server error.",
		});
		expect(x.r.tripped()).toBe(false);
	});

	test("failures more than ten minutes apart do not add up", async () => {
		const x = rig();
		await x.fail("a", stream(1));
		await x.advance(6 * MIN);
		await x.fail("b", stream(2));
		await x.advance(6 * MIN);
		await x.fail("c", stream(3));
		expect(x.r.tripped()).toBe(false);
	});

	test("a retry that was pending when the breaker tripped never goes out", async () => {
		const x = rig();
		await x.fail("a", stream(1));
		await x.fail("b", stream(2));
		await x.fail("c", stream(3));
		expect(x.r.pendingCount()).toBe(0);
		await x.advance(30 * MIN);
		expect(x.pings).toEqual([]);
	});

	test("the breaker resets after ten quiet minutes, and a later outage alarms again", async () => {
		const x = rig();
		for (const [i, id] of ["a", "b", "c"].entries()) await x.fail(id, stream(i + 1));
		expect(x.r.tripped()).toBe(true);
		await x.advance(11 * MIN);
		expect((await x.fail("d", stream(4))).action).toBe("retry-scheduled");
		expect(x.r.tripped()).toBe(false);
		await x.fail("e", stream(5));
		expect(await x.fail("f", stream(6))).toMatchObject({ action: "breaker", alarm: true });
	});

	test("never-retry kinds count too: three auth failures are one alarm, not three wakes", async () => {
		const x = rig();
		const auth = (n: number) => ({
			runId: `run-${n}`,
			class: "provider_error",
			code: "api_error",
			message: "Claude could not authenticate.",
		});
		expect((await x.fail("a", auth(1))).action).toBe("wake");
		expect((await x.fail("b", auth(2))).action).toBe("wake");
		expect(await x.fail("c", auth(3))).toMatchObject({ action: "breaker", kind: "auth", alarm: true });
	});

	test("an interrupted run is not outage evidence", async () => {
		const x = rig();
		for (let n = 0; n < 5; n++) await x.fail(`t${n}`, { runId: `run-${n}`, ...STREAM, interrupted: true });
		expect(x.r.tripped()).toBe(false);
	});
});

describe("the queue items", () => {
	test("the breaker's alarm is one only-you item with at least two options and short bullet context", () => {
		const i = breakerItem("stream_closed", 3, 10 * MIN, {
			thread: "Thread one",
			server: "laptop",
			threadId: "t1",
		}) as any;
		expect(i.kind).toBe("only-you");
		expect(i.options.length).toBeGreaterThanOrEqual(2);
		expect(i.context.split("\n").every((l: string) => l.startsWith("- "))).toBe(true);
		expect(i.title).toContain("stream_closed");
	});
	test("a verdict item names the judge and routes everything to the Steward", () => {
		const i = verdictItem("capacity", "needs a different model", "small-model", {
			thread: "Thread one",
			server: "laptop",
			threadId: "t1",
		}) as any;
		expect(i.context).toContain("small-model judge: needs a different model");
		expect(i.options.every((o: any) => o.route === undefined)).toBe(true);
	});
	test("the judge's brief carries the two errors and the gap, and its verdicts are the three the Steward understands", () => {
		const b = judgeBrief(
			"stream_closed",
			{ runId: "1", class: "unknown", message: "a" },
			{ runId: "2", message: "b" },
			4 * MIN,
		);
		expect(b.user).toContain("4 minutes after the retry");
		expect(b.verdicts).toEqual(["retry_later", "do_not_retry", "ask_principal"]);
	});
	test("defaults: grace 3 minutes, rate-limit wait 15, window and breaker 10 minutes, breaker at 3", () => {
		expect(DEFAULT_RECOVER_TIMING).toMatchObject({
			graceMs: 3 * MIN,
			rateLimitWaitMs: 15 * MIN,
			threadHorizonMs: 6 * 60 * MIN,
			breakerWindowMs: 10 * MIN,
			breakerCount: 3,
		});
	});
});

describe("wording", () => {
	test("every underscore in a kind is humanized: provider_turn_failed reads as words in the queue items", () => {
		const v = verdictItem("provider_turn_failed", "r", "small-model", {
			thread: "T",
			server: "s",
			threadId: "t",
		}) as any;
		expect(v.title).toContain("provider turn failed");
		const b = breakerItem("provider_turn_failed", 3, 10 * MIN, { thread: "T", server: "s" }) as any;
		expect(b.context).toContain("provider turn failed");
	});
});

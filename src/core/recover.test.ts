import { describe, expect, test } from "bun:test";
import { ctx, NOW, rig, STREAM, t } from "../testing/core-recover-fixtures.ts";
import { TABLE } from "../testing/core-recover-table-fixtures.ts";
import type { ThreadState } from "./adapter.ts";
import type { RunFailure } from "./adapter-inspect.ts";
import { classifyFailure, MIN, neverRetryThread, RETRY_KINDS } from "./recover-classify.ts";
import { type Handling, RETRY_TEXT } from "./recover-state.ts";

describe("classifyFailure: the table", () => {
	for (const row of TABLE)
		test(row.name, () => {
			const c = classifyFailure(row.f as RunFailure, NOW);
			expect(c.kind).toBe(row.kind);
			expect(c.retry).toBe(row.retry);
		});

	test("retries exactly the five listed kinds and no others", () => {
		expect([...RETRY_KINDS].sort()).toEqual(["capacity", "oom", "provider_turn_failed", "rate_limit", "stream_closed"]);
		for (const row of TABLE) expect(classifyFailure(row.f as RunFailure, NOW).retry).toBe(RETRY_KINDS.has(row.kind));
	});

	test("a rate limit waits 15 minutes, everything else waits the 3-minute grace", () => {
		expect(classifyFailure({ message: "Claude API rate limit reached.", code: "api_error_429" }, NOW).waitMs).toBe(
			15 * MIN,
		);
		for (const row of TABLE.filter((r) => r.retry && r.kind !== "rate_limit"))
			expect(classifyFailure(row.f as RunFailure, NOW).waitMs).toBe(3 * MIN);
	});

	test("a rate limit that resets within the hour waits until just after the reset", () => {
		const c = classifyFailure({ message: "rate limit reached", resetAt: new Date(NOW + 40 * MIN).toISOString() }, NOW);
		expect(c.kind).toBe("rate_limit");
		expect(c.waitMs).toBe(40 * MIN + 30_000);
	});

	test("a message that fits a never-retry kind and a retry kind is never retried", () => {
		expect(
			classifyFailure(
				{ code: "api_error_503", message: "Failed to authenticate. Attention Required! | Cloudflare" },
				NOW,
			).retry,
		).toBe(false);
		expect(classifyFailure({ message: "Workspace preparation failed: out of memory" }, NOW).retry).toBe(false);
	});

	test("the backend's own retryable flag never makes a never-retry kind retryable", () => {
		expect(
			classifyFailure({ code: "workspace_preparation_failed", retryable: true, message: "x" } as RunFailure, NOW).retry,
		).toBe(false);
	});
});

describe("neverRetryThread: every excluded case", () => {
	test("an ordinary failed top-level thread may be retried", () => expect(neverRetryThread(t(), ctx)).toBeUndefined());
	test("the Steward's thread", () => expect(neverRetryThread(t({ id: "steward" }), ctx)).toMatch(/Steward/));
	test("the Decisions thread", () => expect(neverRetryThread(t({ id: "decisions" }), ctx)).toMatch(/Decisions/));
	test("an open card or approval", () =>
		expect(neverRetryThread(t({ pendingRequestId: "req" }), ctx)).toMatch(/open card/));
	test("a thread whose status is waiting", () =>
		expect(neverRetryThread(t({ status: "waiting" }), ctx)).toMatch(/waiting/));
	test("a wait on another thread", () =>
		expect(neverRetryThread(t({ blockedOnThreadWait: true }), ctx)).toMatch(/another thread/));
	test("a watch or gate parked as background work", () =>
		expect(neverRetryThread(t({ backgroundTasks: 1 }), ctx)).toMatch(/watch, gate/));
	test("children running", () => expect(neverRetryThread(t(), { ...ctx, children: 2 })).toMatch(/children/));
	test("a child thread", () => expect(neverRetryThread(t({ parentThreadId: "p" }), ctx)).toMatch(/child/));
	test("archived, settled and snoozed threads", () => {
		for (const o of [{ archived: true }, { settled: true }, { snoozed: true }])
			expect(neverRetryThread(t(o), ctx)).toMatch(/archived, settled or snoozed/);
	});
});

describe("retry once, after a 3-minute grace", () => {
	test("a transient failure schedules a retry and wakes no one; the retry goes out after exactly the grace, as the daemon", async () => {
		const x = rig();
		const h = await x.fail("t1", { runId: "run-1", ...STREAM });
		expect(h).toMatchObject({ action: "retry-scheduled", kind: "stream_closed", at: NOW + 3 * MIN });
		await x.advance(3 * MIN - 1);
		expect(x.pings).toEqual([]);
		await x.advance(2);
		expect(x.pings).toEqual([{ threadId: "t1", text: RETRY_TEXT, seed: "recover:t1:run-1" }]);
		expect(x.wakes).toEqual([]);
	});

	test("a rate limit retries after 15 minutes, not 3", async () => {
		const x = rig();
		const h = await x.fail("t1", {
			runId: "run-1",
			class: "usage_limit",
			code: "api_error_429",
			message: "Claude API rate limit reached. Try again later.",
		});
		expect(h).toMatchObject({ action: "retry-scheduled", kind: "rate_limit" });
		await x.advance(14 * MIN);
		expect(x.pings).toEqual([]);
		await x.advance(2 * MIN);
		expect(x.pings).toHaveLength(1);
	});

	test("the retry text never names a model: nothing switches model on a capacity retry", async () => {
		const x = rig();
		await x.fail("t1", {
			runId: "run-1",
			class: "provider_error",
			code: "serverOverloaded",
			message: "Selected model is at capacity. Please try a different model.",
		});
		await x.advance(4 * MIN);
		expect(x.pings).toHaveLength(1);
		expect(x.pings[0]!.text).toBe(RETRY_TEXT);
		expect(x.pings[0]!.text).not.toMatch(/model|switch/i);
	});

	test("the same run seen twice is handled once", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		expect(await x.fail("t1", { runId: "run-1", ...STREAM })).toEqual({ action: "duplicate" });
		await x.advance(4 * MIN);
		expect(x.pings).toHaveLength(1);
	});
});

describe("stand down when anyone writes in the thread meanwhile", () => {
	test("a new message from anyone cancels the retry", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.instruction.set("t1", "m2");
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.logs.find((l) => l.event === "recover-stand-down")?.data).toMatchObject({
			why: "someone wrote in the thread",
		});
		expect(x.wakes).toEqual([]);
	});

	test("a hand restart (the thread is no longer failed) cancels it", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.states.set("t1", t({ status: "running", latestRunId: "run-2" }));
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.logs.find((l) => l.event === "recover-stand-down")?.data?.why).toMatch(/active|not failed/);
	});

	test("a newer run on a still-failed thread cancels it", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.states.set("t1", t({ status: "failed", latestRunId: "run-2" }));
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.logs.find((l) => l.event === "recover-stand-down")?.data?.why).toBe("a newer run exists");
	});

	test("moved() (the engine saw a turn begin) cancels it at once", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.r.moved("t1");
		expect(x.r.pendingCount()).toBe(0);
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
	});

	test("a thread that began waiting during the grace is left alone", async () => {
		const x = rig();
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.states.set("t1", t({ pendingRequestId: "req-9" }));
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
	});

	test("messages that cannot be read: no retry, and the Steward hears of the failure", async () => {
		const x = rig({ ctxOver: { instructionId: async () => "unknown" } });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(x.wakes).toHaveLength(1);
		expect(x.wakes[0]!.note).toMatch(/could not be read/);
	});

	test("a retry that cannot be sent wakes the Steward with why", async () => {
		const x = rig({ ping: () => ({ ok: false, detail: "no operate token" }) });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.wakes).toHaveLength(1);
		expect(x.wakes[0]!.note).toMatch(/no operate token/);
	});
});

describe("never retried", () => {
	for (const row of TABLE.filter((r) => !r.retry && r.kind !== "interrupted"))
		test(`${row.name}: the ordinary wake, no retry`, async () => {
			const x = rig();
			const h = await x.fail("t1", { runId: "run-1", ...row.f, message: row.f.message ?? "" });
			expect(h).toMatchObject({ action: "wake", kind: row.kind });
			expect((h as Extract<Handling, { action: "wake" }>).note).toMatch(/not retried automatically/);
			await x.advance(30 * MIN);
			expect(x.pings).toEqual([]);
		});

	test("an interrupted run", async () => {
		const x = rig();
		const h = await x.fail("t1", { runId: "run-1", ...STREAM, interrupted: true });
		expect(h).toMatchObject({ action: "wake", kind: "interrupted" });
		await x.advance(30 * MIN);
		expect(x.pings).toEqual([]);
	});

	const waiting: [string, Partial<ThreadState>][] = [
		["an open card", { pendingRequestId: "req" }],
		["status waiting", { status: "waiting" }],
		["a wait on another thread", { blockedOnThreadWait: true }],
		["a watch or gate parked", { backgroundTasks: 1 }],
	];
	for (const [name, over] of waiting)
		test(`a waiting thread (${name})`, async () => {
			const x = rig();
			const h = await x.fail("t1", { runId: "run-1", ...STREAM }, over);
			expect(h).toMatchObject({ action: "wake" });
			await x.advance(30 * MIN);
			expect(x.pings).toEqual([]);
		});

	test("a thread with children running", async () => {
		const x = rig({ ctxOver: { children: async () => 1 } });
		expect((await x.fail("t1", { runId: "run-1", ...STREAM })).action).toBe("wake");
		await x.advance(30 * MIN);
		expect(x.pings).toEqual([]);
	});

	test("the Steward thread and the Decisions thread", async () => {
		const x = rig();
		for (const id of ["steward", "decisions"]) {
			const h = await x.fail(id, { runId: `run-${id}`, ...STREAM });
			expect(h).toMatchObject({ action: "wake", note: expect.stringMatching(/not retried automatically/) });
		}
		await x.advance(30 * MIN);
		expect(x.pings).toEqual([]);
	});

	test("a failure the adapter cannot read is the ordinary wake and counts toward no outage", async () => {
		const x = rig();
		x.states.set("t1", t());
		for (let n = 0; n < 5; n++)
			expect(await x.r.onFailure(t({ latestRunId: `run-${n}` }))).toMatchObject({
				action: "wake",
				note: expect.stringMatching(/could not be read/),
			});
		expect(x.r.tripped()).toBe(false);
	});
});

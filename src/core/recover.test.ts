import { describe, expect, test } from "bun:test";
import type { RunFailure, RunLook, ThreadState } from "./adapter.ts";
import { normalizeThread } from "./adapter.ts";
import { retrySeed } from "./recover.ts";
import {
	breakerItem,
	classifyFailure,
	createRecovery,
	DEFAULT_RECOVER_TIMING,
	judgeBrief,
	memoryRecoverStore,
	MIN,
	neverRetryThread,
	outcomeOf,
	RETRY_KINDS,
	RETRY_TEXT,
	verdictItem,
	type FailureKind,
	type Handling,
	type RecoverDeps,
	type RecoverStore,
} from "./recover.ts";
import type { JudgeAnswer } from "./judge.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");

/** The failures T3 recorded for real runs since 2026-10-25, one row each: what the table must say about them. */
const TABLE: { name: string; f: Partial<RunFailure>; kind: FailureKind; retry: boolean }[] = [
	{
		name: "rate limit (33 runs)",
		f: { class: "usage_limit", code: "api_error_429", message: "Claude API rate limit reached. Try again later." },
		kind: "rate_limit",
		retry: true,
	},
	{
		name: "stream closed (20 runs)",
		f: {
			class: "unknown",
			message:
				"The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.",
		},
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "provider turn failed",
		f: { class: "transport_error", message: "Provider turn failed." },
		kind: "provider_turn_failed",
		retry: true,
	},
	{
		name: "response stream disconnected",
		f: {
			class: "transport_error",
			code: "responseStreamDisconnected",
			retryable: true,
			message: "workspace routing discovery timed out",
		},
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "routing discovery timed out, class other",
		f: { class: "provider_error", code: "other", message: "workspace routing discovery timed out" },
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "server error 503",
		f: { class: "provider_error", code: "api_error_503", retryable: true, message: "Claude API server error." },
		kind: "capacity",
		retry: true,
	},
	{
		name: "model at capacity",
		f: {
			class: "provider_error",
			code: "serverOverloaded",
			message: "Error running remote compact task: Selected model is at capacity. Please try a different model.",
		},
		kind: "capacity",
		retry: true,
	},
	{
		name: "out of memory",
		f: { class: "transport_error", code: "oom_kill", message: "Killed: out of memory." },
		kind: "oom",
		retry: true,
	},
	{
		name: "auth",
		f: {
			class: "provider_error",
			code: "api_error",
			message:
				"Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread.",
		},
		kind: "auth",
		retry: false,
	},
	{
		name: "Cloudflare 403",
		f: {
			class: "provider_error",
			code: "api_error_403",
			message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		},
		kind: "cloudflare",
		retry: false,
	},
	{
		name: "safety: misalignment policy",
		f: {
			class: "provider_error",
			code: "misalignmentPolicyViolation",
			message: "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
		},
		kind: "safety",
		retry: false,
	},
	{
		name: "safety: cyber policy",
		f: {
			class: "provider_error",
			code: "cyberPolicy",
			message: "This content was flagged for possible cybersecurity risk.",
		},
		kind: "safety",
		retry: false,
	},
	{
		name: "workspace preparation",
		f: {
			class: "validation_error",
			code: "workspace_preparation_failed",
			retryable: false,
			message:
				"Workspace preparation failed during provision worktree: Git command failed in GitVcsDriver.createWorktree.createBranch (/home/x/dev/Y)",
		},
		kind: "workspace",
		retry: false,
	},
	{
		name: "git error without a code",
		f: { message: "Git command failed in GitVcsDriver.status" },
		kind: "workspace",
		retry: false,
	},
	{
		name: "quota by message",
		f: { class: "usage_limit", code: "api_error_429", message: "You have exceeded your monthly usage limit." },
		kind: "quota",
		retry: false,
	},
	{
		name: "quota by a far reset",
		f: {
			class: "usage_limit",
			code: "api_error_429",
			message: "Claude API rate limit reached.",
			resetAt: new Date(NOW + 5 * 3600_000).toISOString(),
		},
		kind: "quota",
		retry: false,
	},
	{
		name: "interrupted flag",
		f: { message: "Provider turn failed.", interrupted: true },
		kind: "interrupted",
		retry: false,
	},
	{
		name: "anything else is unknown",
		f: { class: "weird", message: "something nobody has seen" },
		kind: "unknown",
		retry: false,
	},
	{ name: "an empty message is unknown", f: { message: "" }, kind: "unknown", retry: false },
];

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

const t = (over: Partial<ThreadState> = {}): ThreadState =>
	normalizeThread({ id: "t1", title: "Thread one", status: "failed", latestRunId: "run-1", ...over });
const ctx = { stewardId: "steward", decisionsId: "decisions", children: 0 };

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

/** A recovery on a manual clock: timers run when the test advances time, and every effect is recorded. */
type World = {
	now: () => number;
	states: Map<string, ThreadState>;
	failures: Map<string, RunFailure | undefined>;
	instruction: Map<string, string>;
};
function rig(
	o: {
		failures?: Record<string, RunFailure | undefined>;
		judge?: () => JudgeAnswer;
		ping?: () => {
			ok: boolean;
			detail: string;
		} /** runs when a ping is sent, before it is answered: a crash is simulated here */;
		onPing?: () => void;
		ctxOver?: Partial<RecoverDeps>;
		store?: RecoverStore;
		look?: (
			id: string,
		) => Promise<RunLook | undefined> /** a rig for the same world after a restart: same clock, threads and store */;
		share?: World;
	} = {},
) {
	let now = o.share?.now() ?? NOW;
	const timers: { at: number; fn: () => void; live: boolean }[] = [];
	const states = o.share?.states ?? new Map<string, ThreadState>();
	const failures = o.share?.failures ?? new Map<string, RunFailure | undefined>(Object.entries(o.failures ?? {}));
	const instruction = o.share?.instruction ?? new Map<string, string>();
	const pings: { threadId: string; text: string; seed: string }[] = [];
	const wakes: { threadId: string; kind: FailureKind; note: string }[] = [];
	const logs: { event: string; data?: Record<string, unknown> }[] = [];
	const judged: { trigger: string; user: string }[] = [];
	const r = createRecovery({
		now: () => now,
		setTimer: (ms, fn) => {
			const x = { at: now + ms, fn, live: true };
			timers.push(x);
			return () => {
				x.live = false;
			};
		},
		stewardId: () => "steward",
		decisionsId: () => "decisions",
		state: (id) => states.get(id),
		/** By default a fresh read agrees with what the daemon holds. */
		look:
			o.look ??
			(async (id) => {
				const th = states.get(id);
				return th
					? {
							latestRunId: th.latestRunId ?? undefined,
							latestStatus: th.status,
							active: ["running", "starting", "queued", "preparing"].includes(th.status),
							waiting: th.status === "waiting" || th.pendingRequestId !== null,
						}
					: undefined;
			}),
		...(o.store ? { store: o.store } : {}),
		children: async () => 0,
		readFailure: async (id) => failures.get(id),
		instructionId: async (id) => instruction.get(id) ?? "m1",
		ping: async (threadId, text, seed) => {
			pings.push({ threadId, text, seed });
			o.onPing?.();
			return o.ping?.() ?? { ok: true, detail: "sent" };
		},
		judge: async (trigger, brief) => {
			judged.push({ trigger, user: brief.user });
			return o.judge?.() ?? { ok: true, backend: "small-model", verdict: "do_not_retry", reason: "it keeps happening" };
		},
		wake: (threadId, kind, note) => wakes.push({ threadId, kind, note }),
		log: (event, data) => logs.push({ event, data }),
		...o.ctxOver,
	});
	/** Moves the clock and runs every timer that falls due, in order, letting each one's async work finish. */
	const advance = async (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			next.live = false;
			now = Math.max(now, next.at);
			next.fn();
			await Bun.sleep(1);
		}
		now = end;
	};
	const fail = (
		id: string,
		f: Partial<RunFailure> & { runId: string },
		over: Partial<ThreadState> = {},
	): Promise<Handling> => {
		const full: RunFailure = { message: "The provider event stream closed unexpectedly.", class: "unknown", ...f };
		failures.set(id, full);
		const th = t({ id, latestRunId: f.runId, ...over });
		states.set(id, th);
		return r.onFailure(th);
	};
	return { r, advance, fail, states, failures, instruction, pings, wakes, logs, judged, now: () => now };
}

const STREAM = { message: "The provider event stream closed unexpectedly. Retry the turn." };

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
		const evil = "provider /home/someone/secret a@b.co " + "k".repeat(80);
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

describe("write-ahead, and a retry message id that is the same after a restart", () => {
	/** A store that stops persisting at the moment of a crash, as a dead process would. */
	const crashable = () => {
		const inner = memoryRecoverStore();
		const dead = { v: false };
		const store: RecoverStore = {
			load: () => inner.load(),
			save: (s) => {
				if (!dead.v) inner.save(s);
			},
		};
		return { inner, dead, store };
	};
	const failStream = (runId: string) => ({ runId, message: "The provider event stream closed unexpectedly." });

	test("crash after the send was accepted, before anything more was recorded: after the restart the retry fails, and there is exactly one ping and one judge call", async () => {
		const c = crashable();
		const a = rig({
			store: c.store,
			onPing: () => {
				c.dead.v = true;
				a.r.stop();
			},
		});
		await a.fail("t1", failStream("run-1"));
		await a.advance(4 * MIN);
		expect(a.pings).toHaveLength(1);
		// T3 accepted the message: a run began on the thread, and the process died before it could write anything else.
		a.states.set("t1", t({ status: "running", latestRunId: "run-2" }));
		const b = rig({ store: c.inner, share: a });
		b.r.restore();
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
		expect(b.pings).toEqual([]);
		// The retry fails.
		const h = await b.fail("t1", failStream("run-2"));
		expect(h).toMatchObject({ action: "verdict" });
		expect(a.pings.length + b.pings.length).toBe(1);
		expect(b.judged).toHaveLength(1);
	});

	test("the same crash, but the message never reached T3: the restart re-sends the very same message id, and the failure after it goes to the judge", async () => {
		const c = crashable();
		const a = rig({
			store: c.store,
			onPing: () => {
				c.dead.v = true;
				a.r.stop();
			},
		});
		await a.fail("t1", { ...failStream("run-1"), ordinal: 981 });
		await a.advance(4 * MIN);
		expect(a.pings).toHaveLength(1);
		const b = rig({ store: c.inner, share: a });
		b.r.restore();
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
		expect(b.pings).toHaveLength(1);
		expect(b.pings[0]!.seed).toBe(a.pings[0]!.seed);
		expect(a.pings[0]!.seed).toBe("recover:t1:981");
		expect(await b.fail("t1", failStream("run-2"))).toMatchObject({ action: "verdict" });
		expect(b.judged).toHaveLength(1);
	});

	test("the attempt is on disk before the message is sent: a state read at the moment of the send already counts it", async () => {
		const inner = memoryRecoverStore();
		let seen: unknown;
		const a = rig({
			store: inner,
			onPing: () => {
				seen = JSON.parse(JSON.stringify(inner.load()));
			},
		});
		await a.fail("t1", failStream("run-1"));
		await a.advance(4 * MIN);
		const rec = (seen as { threads: Record<string, { pings: number; retried?: { runId: string }; pending?: unknown }> })
			.threads.t1!;
		expect(rec.pings).toBe(1);
		expect(rec.retried?.runId).toBe("run-1");
		expect(rec.pending).toBeDefined();
	});

	test("a retry the server refused outright ('not sent: ...') is withdrawn, so the next failure is a first failure again", async () => {
		let refuse = true;
		const x = rig({
			ping: () =>
				refuse
					? { ok: false, detail: "not sent: the thread is waiting on a card, approval or question" }
					: { ok: true, detail: "sent" },
		});
		await x.fail("t1", failStream("run-1"));
		await x.advance(4 * MIN);
		expect(x.wakes).toHaveLength(1);
		refuse = false;
		x.states.set("t1", t({ latestRunId: "run-1" }));
		expect((await x.fail("t1", failStream("run-2"))).action).toBe("retry-scheduled");
	});

	test("a send that failed in an unknown way stays counted, so a repeat is never a second first ping", async () => {
		const x = rig({ ping: () => ({ ok: false, detail: "send timed out after 10000 ms" }) });
		await x.fail("t1", failStream("run-1"));
		await x.advance(4 * MIN);
		expect(x.wakes).toHaveLength(1);
		expect(await x.fail("t1", failStream("run-2"))).toMatchObject({ action: "verdict" });
	});

	test("the seed is the thread and the failed run's ordinal, never random: it repeats for one failure and differs between stretches", () => {
		expect(retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 })).toBe("recover:t1:981");
		expect(retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 })).toBe(
			retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 }),
		);
		expect(retrySeed("t1", { runId: "a", ordinal: 981 })).not.toBe(retrySeed("t1", { runId: "b", ordinal: 1200 }));
		expect(retrySeed("t2", { runId: "a", ordinal: 981 })).not.toBe(retrySeed("t1", { runId: "a", ordinal: 981 }));
		expect(retrySeed("t1", { runId: "run-7" })).toBe("recover:t1:run-7");
	});
});

describe("fault injection over every crash and failure point of the recovery sequence", () => {
	/**
	 * One stall (run-1 fails, a retry is due), then a fault at one point of the sequence, then, where the row says so, a restart, then the
	 * next failure (run-2). Every row is checked against the same invariants:
	 *   - at most one retry message reaches T3 for the stall (`sent`), and never a duplicate;
	 *   - the counters match what happened: an attempt that may have been sent stays counted, one that was withdrawn leaves no trace, and
	 *     no half-made attempt (`pending.attempt`) is left behind;
	 *   - the next failure goes to the judge exactly when a retry may have gone out, and is a fresh first failure (retried once) otherwise.
	 */
	type Crash = "before-save" | "after-save" | "send-accepted" | "after-send" | "after-record";
	type Fault = "save-fails" | "refused" | "throws" | "unknown-error";
	type Row = {
		name: string;
		/** a process death at this point (nothing after it happens in that process) */
		crash?: Crash;
		/** a failure at this point; it is injected in the process named by `on` */
		fault?: Fault;
		on?: "A" | "B";
		restart: boolean;
		/** retry messages that reached T3 */
		sent: number;
		/** the counters after the faulted attempt: pings counted, and whether a retry is recorded as made */
		counters: { pings: number; retried: boolean };
		/** what the next failure does */
		next: "verdict" | "retry-scheduled";
		/** a wake to the Steward about the retry, matching this */
		wake?: RegExp;
	};
	const MATRIX: Row[] = [
		{ name: "no fault", restart: false, sent: 1, counters: { pings: 1, retried: true }, next: "verdict" },
		{
			name: "crash before the save",
			crash: "before-save",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
		},
		{
			name: "the save fails",
			fault: "save-fails",
			on: "A",
			restart: false,
			sent: 0,
			counters: { pings: 0, retried: false },
			next: "retry-scheduled",
			wake: /could not be saved \(disk full\)/,
		},
		{
			name: "the save fails, then a restart",
			fault: "save-fails",
			on: "A",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
			wake: /could not be saved \(disk full\)/,
		},
		{
			name: "crash after the save, before the send",
			crash: "after-save",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
		},
		{
			name: "crash with the send accepted",
			crash: "send-accepted",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
		},
		{
			name: "the send is refused (not sent)",
			fault: "refused",
			on: "A",
			restart: false,
			sent: 0,
			counters: { pings: 0, retried: false },
			next: "retry-scheduled",
			wake: /\(not sent: .*\), so nothing has been retried/,
		},
		{
			name: "crash after the save, restart, then the send is refused (not sent)",
			crash: "after-save",
			fault: "refused",
			on: "B",
			restart: true,
			sent: 0,
			counters: { pings: 0, retried: false },
			next: "retry-scheduled",
			wake: /\(not sent: .*\), so nothing has been retried/,
		},
		{
			name: "the send throws",
			fault: "throws",
			on: "A",
			restart: false,
			sent: 0,
			counters: { pings: 1, retried: true },
			next: "verdict",
			wake: /may have been delivered \(the send threw: socket hang up\); it is counted as sent/,
		},
		{
			name: "the send fails in a way that may have landed",
			fault: "unknown-error",
			on: "A",
			restart: false,
			sent: 0,
			counters: { pings: 1, retried: true },
			next: "verdict",
			wake: /may have been delivered \(.*send timed out.*\); it is counted as sent/,
		},
		{
			name: "crash after the send, before it is recorded",
			crash: "after-send",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
		},
		{
			name: "crash after the record",
			crash: "after-record",
			restart: true,
			sent: 1,
			counters: { pings: 1, retried: true },
			next: "verdict",
		},
	];

	for (const row of MATRIX)
		test(row.name, async () => {
			const inner = memoryRecoverStore();
			const delivered: { seed: string; by: string }[] = [];
			const stream = (runId: string) => ({
				runId,
				ordinal: runId === "run-1" ? 1 : 2,
				message: "The provider event stream closed unexpectedly.",
			});
			/** One process: its store drops every write after its death, and its effects after death never happen (a dead process does not wake anyone). */
			const process_ = (side: "A" | "B") => {
				const dead = { v: false };
				let wroteAhead = false;
				const faulty = (row.on ?? "A") === side;
				const store: RecoverStore = {
					load: () => inner.load(),
					save: (s) => {
						if (dead.v) return;
						const writeAhead = Object.values(s.threads).some((th) => th.pending?.attempt);
						if (writeAhead && !wroteAhead) {
							wroteAhead = true;
							if (side === "A" && row.crash === "before-save") {
								dead.v = true;
								return;
							}
							if (faulty && row.fault === "save-fails") throw Error("disk full");
						}
						inner.save(s);
					},
				};
				let faulted = false;
				/** A fault happens once, at the point under test; the retry that follows it is not faulted again. */
				const hit = (f: Fault) => {
					if (faulty && row.fault === f && !faulted) {
						faulted = true;
						return true;
					}
					return false;
				};
				const ping: NonNullable<RecoverDeps["ping"]> = async (_id, _text, seed) => {
					if (dead.v) return new Promise<never>(() => {});
					if (side === "A" && row.crash === "after-save") {
						dead.v = true;
						return new Promise<never>(() => {});
					}
					if (hit("refused"))
						return { ok: false, detail: "not sent: the thread is waiting on a card, approval or question" };
					if (hit("throws")) throw Error("socket hang up");
					if (hit("unknown-error")) return { ok: false, detail: "send timed out after 10000 ms" };
					// T3 accepts it: a run begins on the thread.
					delivered.push({ seed, by: side });
					w.states.set("t1", t({ status: "running", latestRunId: "run-2" }));
					if (side === "A" && row.crash === "send-accepted") {
						dead.v = true;
						return new Promise<never>(() => {});
					}
					if (side === "A" && row.crash === "after-send") dead.v = true;
					return { ok: true, detail: "sent" };
				};
				return { store, ping, dead };
			};
			const pa = process_("A");
			const a = rig({
				store: pa.store,
				ctxOver: {
					ping: pa.ping,
					wake: (threadId, kind, note) => {
						if (!pa.dead.v) a.wakes.push({ threadId, kind, note });
					},
				},
			});
			const w = a;
			await a.fail("t1", stream("run-1"));
			await a.advance(4 * MIN);
			if (row.crash === "after-record") pa.dead.v = true;
			let side = a;
			if (row.restart) {
				a.r.stop();
				const pb = process_("B");
				side = rig({ store: pb.store, share: a, ctxOver: { ping: pb.ping } });
				side.r.restore();
				await side.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
			}
			// What the faulted attempt left behind.
			const th = inner.load()?.threads.t1;
			expect(delivered.length).toBe(row.sent);
			expect(new Set(delivered.map((m) => m.seed)).size).toBe(row.sent);
			if (row.sent) expect(delivered[0]!.seed).toBe("recover:t1:1");
			expect(th?.pings ?? 0).toBe(row.counters.pings);
			expect(th?.retried !== undefined).toBe(row.counters.retried);
			expect(th?.pending?.attempt).toBeUndefined();
			const wakes = [...a.wakes, ...(side === a ? [] : side.wakes)];
			if (row.wake) expect(wakes.some((x) => row.wake!.test(x.note))).toBe(true);
			else expect(wakes).toEqual([]);
			// The next failure.
			const h = await side.fail("t1", stream("run-2"));
			expect(h.action).toBe(row.next);
			const judges = side === a ? a.judged.length : side.judged.length;
			expect(judges).toBe(row.next === "verdict" ? 1 : 0);
			if (row.next === "retry-scheduled") {
				// A withdrawn or never-made attempt leaves the stall its one retry: it goes out now, and it is the only one.
				w.states.set("t1", t({ latestRunId: "run-2" }));
				await side.advance(4 * MIN);
				expect(delivered.length).toBe(1);
			} else {
				expect(delivered.length).toBeLessThanOrEqual(1);
			}
		});

	test("the matrix covers every crash point and every failure of the send, and each only once", () => {
		const crashes = new Set(MATRIX.map((r) => r.crash).filter(Boolean));
		for (const c of ["before-save", "after-save", "send-accepted", "after-send", "after-record"] as const)
			expect(crashes.has(c)).toBe(true);
		const faults = new Set(MATRIX.map((r) => r.fault).filter(Boolean));
		for (const f of ["save-fails", "refused", "throws", "unknown-error"] as const) expect(faults.has(f)).toBe(true);
		expect(new Set(MATRIX.map((r) => r.name)).size).toBe(MATRIX.length);
	});
});

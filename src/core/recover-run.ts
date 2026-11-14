/** Stalled-thread recovery: sending one retry and handling one failure. */
import type { ThreadState } from "./adapter.ts";
import type { RunFailure } from "./adapter-inspect.ts";
import { type Classified, classifyFailure, judgeBrief, neverRetryThread, type Verdict } from "./recover-classify.ts";
import {
	arm,
	type Before,
	clearPending,
	count,
	type Env,
	holdReason,
	type Pending,
	rec,
	restoreCounters,
	save,
	saveStrict,
	standDown,
	threadContext,
	tripped,
} from "./recover-env.ts";
import { HANDLED_MAX, type Handling, RETRY_TEXT, retrySeed, type ThreadRecord } from "./recover-state.ts";

/**
 * Write-ahead, failing closed: the attempt is recorded durably BEFORE the send, and the retry stays pending until the send is answered.
 * If the record cannot be saved, nothing is sent. A crash after T3 accepted the message finds the attempt recorded (the next failure is
 * the second one and goes to the judge); a crash before it re-sends the same message id (retrySeed), which T3 drops if the first one did
 * land. The counters as they were before the attempt are saved with it, so a refusal that sent nothing can restore them exactly.
 */
function beginAttempt(rc: Env, threadId: string, p: Pending) {
	rc.timers.delete(threadId);
	const tr = rec(rc, threadId);
	const first = p.attempt === undefined;
	const before: Before = p.attempt ?? { pings: tr.pings, retried: tr.retried ?? null };
	if (first) {
		p.attempt = before;
		tr.pings++;
		tr.retried = { runId: p.runId, at: rc.now(), failure: p.failure, kind: p.kind };
	}
	return { tr, before, first };
}

/** One retry being sent: the thread, its pending retry, and what beginning the attempt recorded. */
type Sending = { threadId: string; p: Pending; begun: ReturnType<typeof beginAttempt> };

/** The record of the attempt could not be saved: nothing was sent, so the counters go back and the Steward is told. */
function abandonUnsaved(rc: Env, { threadId, p, begun }: Sending, unsaved: string) {
	if (begun.first) {
		restoreCounters(begun.tr, begun.before);
		delete p.attempt;
	}
	clearPending(rc, threadId);
	rc.d.wake(
		threadId,
		p.kind,
		`the automatic retry was not sent because its record could not be saved (${unsaved}), so nothing has been retried`,
	);
}

/** The send was answered with a failure. */
function pingRefused(rc: Env, { threadId, p, begun }: Sending, detail: string) {
	// Only a refusal that says nothing was sent withdraws the attempt, and it restores the counters exactly as they were. Any other failure
	// may have been sent, so the attempt stays counted: a confirmed acceptance is the only thing treated as sent, and a doubt is never treated as unsent.
	const notSent = detail.startsWith("not sent:");
	if (notSent) restoreCounters(begun.tr, begun.before);
	save(rc);
	rc.d.log("recover-ping-failed", { threadId, runId: p.runId, detail });
	rc.d.wake(
		threadId,
		p.kind,
		notSent
			? `the automatic retry could not be sent (${detail}), so nothing has been retried`
			: `the automatic retry may have been delivered (${detail}); it is counted as sent, so check the thread before retrying again`,
	);
}

export async function attempt(rc: Env, threadId: string) {
	const p = rc.st.threads[threadId]?.pending;
	if (!p) return;
	if (tripped(rc)) return standDown(rc, threadId, p, "outage breaker is tripped");
	// Every read that can take time comes first; what is checked after them is read once more, synchronously, right before the ping.
	const instruction = await rc.d.instructionId(threadId).catch(() => "unknown");
	const children = await rc.d.children(threadId).catch(() => 0);
	const look = await rc.d.look(threadId).catch(() => undefined);
	const hold = holdReason(rc, threadId, p, { instruction, children, look });
	if (hold) {
		standDown(rc, threadId, p, hold.why);
		if (hold.wake) rc.d.wake(threadId, p.kind, hold.wake);
		return;
	}
	const begun = beginAttempt(rc, threadId, p);
	const unsaved = saveStrict(rc);
	if (unsaved !== undefined) return abandonUnsaved(rc, { threadId, p, begun }, unsaved);
	let r: { ok: boolean; detail: string };
	try {
		r = await rc.d.ping(threadId, RETRY_TEXT, retrySeed(threadId, p.failure));
	} catch (e) {
		r = { ok: false, detail: `the send threw: ${String(e instanceof Error ? e.message : e).slice(0, 160)}` };
	}
	clearPending(rc, threadId);
	if (!r.ok) return pingRefused(rc, { threadId, p, begun }, r.detail);
	save(rc);
	rc.d.log("recover-retried", { threadId, runId: p.runId, kind: p.kind });
}

/** The backend's record of a thread's newest failure; one that cannot be read is logged and comes back undefined. */
export function readFailure(rc: Env, threadId: string): Promise<RunFailure | undefined> {
	return rc.d.readFailure(threadId).catch((e) => {
		rc.d.log("recover-read-failed", { threadId, error: String(e).slice(0, 160) });
		return undefined;
	});
}

/** Marks a run handled, remembering the newest HANDLED_MAX; false when it already was. */
function markHandled(rc: Env, runId: string): boolean {
	if (rc.st.handled.includes(runId)) return false;
	rc.st.handled.push(runId);
	if (rc.st.handled.length > HANDLED_MAX) rc.st.handled.shift();
	save(rc);
	return true;
}

/** The Steward's and the Decisions thread's failures are never the daemon's to handle, and are not outage evidence. */
function loneThread(rc: Env, threadId: string): string | undefined {
	if (rc.d.stewardId() === threadId) return "the Steward's thread";
	if (rc.d.decisionsId() === threadId) return "the Decisions thread";
	return undefined;
}

/** Counts the failure toward the outage breaker (an interrupted run is no evidence of one); the breaker's handling when it is tripped. */
function outageHandling(rc: Env, c: Classified, at: number, threadId: string): Handling | undefined {
	if (c.kind === "interrupted") return undefined;
	const b = count(rc, c.kind, at);
	save(rc);
	if (!b.tripped) return undefined;
	rc.d.log("recover-breaker", { kind: c.kind, count: b.n, fresh: b.fresh, threadId });
	return { action: "breaker", kind: c.kind, alarm: b.fresh, count: b.n };
}

/**
 * The retry this thread's second failure follows, when it is one: a failure after the retry goes to the judge, whenever within the horizon, unless it is
 * a kind that is never retried anyway: those go straight to the Steward.
 */
function priorRetry(
	rc: Env,
	tr: ThreadRecord,
	{ runId, at, c }: { runId: string; at: number; c: Classified },
): NonNullable<ThreadRecord["retried"]> | undefined {
	const prior = tr.retried;
	if (tr.judged || !prior || prior.runId === runId || !(at - prior.at <= rc.t.threadHorizonMs)) return undefined;
	return c.retry || c.kind === "unknown" ? prior : undefined;
}

/** Hands a thread's second failure to the judge, and holds the thread until it completes a turn. */
async function judgeSecondFailure(
	rc: Env,
	threadId: string,
	tr: ThreadRecord,
	failed: { prior: NonNullable<ThreadRecord["retried"]>; c: Classified; failure: RunFailure; at: number },
): Promise<Handling> {
	const { prior, c, failure, at } = failed;
	tr.judged = true;
	delete tr.retried;
	clearPending(rc, threadId);
	save(rc);
	const brief = judgeBrief(c.kind, prior.failure, failure, at - prior.at);
	const j = await rc.d.judge("stalled-recovery", brief);
	rc.d.log("recover-judged", {
		threadId,
		kind: c.kind,
		backend: j.backend,
		ok: j.ok,
		verdict: j.ok ? j.verdict : undefined,
		failures: tr.failures.length,
	});
	if (!j.ok)
		return { action: "verdict", kind: c.kind, backend: j.backend, verdict: "unjudged", reason: j.error, ask: false };
	return {
		action: "verdict",
		kind: c.kind,
		backend: j.backend,
		verdict: j.verdict as Verdict,
		reason: j.reason,
		ask: j.verdict === "ask_principal",
	};
}

/** Why a first failure of a thread is not retried, or undefined when it may be. */
function noRetryNote(tr: ThreadRecord, c: Classified): string | undefined {
	if (!c.retry) return `not retried automatically: ${c.why}`;
	if (tr.judged)
		return `not retried automatically: the judge has already seen this thread fail twice (${tr.failures.length} failures so far)`;
	if (tr.pings > 0) return "not retried automatically: the thread has already been retried once";
	return undefined;
}

/** Schedules the one retry of a thread's first failure, after the kind's wait. */
async function scheduleRetry(
	rc: Env,
	threadId: string,
	tr: ThreadRecord,
	failed: { c: Classified; failure: RunFailure; at: number; runId: string },
): Promise<Handling> {
	const { c, failure, at, runId } = failed;
	clearPending(rc, threadId);
	const instruction = await rc.d.instructionId(threadId).catch(() => "unknown");
	const waitMs = c.waitMs;
	tr.pending = { runId, kind: c.kind, failure, instruction, due: at + waitMs };
	save(rc);
	arm(rc, threadId, waitMs);
	rc.d.log("recover-scheduled", { threadId, runId, kind: c.kind, inMs: waitMs });
	return { action: "retry-scheduled", kind: c.kind, at: at + waitMs };
}

/** One failed thread. Returns what the daemon should do about its wake. */
export async function onFailure(rc: Env, thread: ThreadState): Promise<Handling> {
	const at = rc.now();
	const read = await readFailure(rc, thread.id);
	const runId = read?.runId ?? thread.latestRunId ?? `${thread.id}@${at}`;
	if (!markHandled(rc, runId)) return { action: "duplicate" };
	const failure: RunFailure = read ?? { runId, message: "" };
	const c = classifyFailure(failure, at, rc.t);
	const wake = (note: string): Handling => ({ action: "wake", kind: c.kind, note });
	// A failure that cannot be read says nothing of its kind, so it is no evidence of an outage and nothing to retry.
	if (!read) return wake("the failure could not be read, so nothing was retried automatically");
	const lone = loneThread(rc, thread.id);
	if (lone) return wake(`not retried automatically: ${lone}`);
	const outage = outageHandling(rc, c, at, thread.id);
	if (outage) return outage;
	const stop = neverRetryThread(rc.d.state(thread.id) ?? thread, await threadContext(rc, thread.id));
	if (stop) return wake(`not retried automatically: ${stop}`);
	if (c.kind === "interrupted") return wake(`not retried automatically: ${c.why}`);
	const tr = rec(rc, thread.id);
	tr.failures = tr.failures.filter((x) => at - x.at <= rc.t.threadHorizonMs);
	tr.failures.push({ runId, at, kind: c.kind });
	save(rc);
	const prior = priorRetry(rc, tr, { runId, at, c });
	if (prior) return judgeSecondFailure(rc, thread.id, tr, { prior, c, failure, at });
	const note = noRetryNote(tr, c);
	if (note) return wake(note);
	return scheduleRetry(rc, thread.id, tr, { c, failure, at, runId });
}

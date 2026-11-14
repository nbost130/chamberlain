/** Stalled-thread recovery: the environment one recovery runs in (its state, timers and breaker) and the checks on a pending retry. */
import type { RunLook, ThreadState } from "./adapter.ts";
import { type FailureKind, neverRetryThread, type RecoverTiming, type ThreadContext } from "./recover-classify.ts";
import { attempt } from "./recover-run.ts";
import type { RecoverDeps, RecoverState, RecoverStore, ThreadRecord } from "./recover-state.ts";

/** What one recovery holds: its dependencies, clock, timing, persisted state, and the cancel handle of each armed retry timer. */
export type Env = {
	d: RecoverDeps;
	now: () => number;
	t: RecoverTiming;
	timer: (ms: number, fn: () => void) => () => void;
	store: RecoverStore;
	st: RecoverState;
	timers: Map<string, () => void>;
};
export type Pending = NonNullable<ThreadRecord["pending"]>;
/** A thread's counters as they were before an attempt. */
export type Before = NonNullable<Pending["attempt"]>;

export const clockTimer = (ms: number, fn: () => void) => {
	const h = setTimeout(fn, ms);
	return () => clearTimeout(h);
};

export const save = (rc: Env) => {
	try {
		rc.store.save(rc.st);
	} catch (e) {
		rc.d.log("recover-state-unsaved", { error: String(e).slice(0, 160) });
	}
};
/** The save the write-ahead depends on: it reports its failure instead of swallowing it, because a send with no durable record must not happen. */
export const saveStrict = (rc: Env): string | undefined => {
	try {
		rc.store.save(rc.st);
		return undefined;
	} catch (e) {
		rc.d.log("recover-state-unsaved", { error: String(e).slice(0, 160) });
		return String(e instanceof Error ? e.message : e).slice(0, 160);
	}
};
export const rec = (rc: Env, id: string): ThreadRecord => (rc.st.threads[id] ??= { failures: [], pings: 0 });
export const threadContext = async (rc: Env, id: string): Promise<ThreadContext> => ({
	stewardId: rc.d.stewardId(),
	decisionsId: rc.d.decisionsId(),
	children: await rc.d.children(id).catch(() => 0),
});
export const clearPending = (rc: Env, id: string) => {
	rc.timers.get(id)?.();
	rc.timers.delete(id);
	const r = rc.st.threads[id];
	if (r?.pending) delete r.pending;
};
const cancelAll = (rc: Env) => {
	for (const id of Object.keys(rc.st.threads)) clearPending(rc, id);
	for (const c of rc.timers.values()) c();
	rc.timers.clear();
	save(rc);
};
export const tripped = (rc: Env) => rc.st.breaker.trippedAt !== undefined;

/** The breaker: true when this failure is the one that trips it. */
export function count(rc: Env, kind: FailureKind, at: number): { tripped: boolean; fresh: boolean; n: number } {
	const b = rc.st.breaker;
	if (b.trippedAt !== undefined && at - b.lastFailureAt > rc.t.breakerQuietMs) {
		delete b.trippedAt;
		b.failures = [];
		rc.d.log("recover-breaker-reset", {});
	}
	b.lastFailureAt = at;
	b.failures = b.failures.filter((x) => at - x.at <= rc.t.breakerWindowMs);
	b.failures.push({ at, kind });
	const n = b.failures.filter((x) => x.kind === kind).length;
	if (b.trippedAt !== undefined) return { tripped: true, fresh: false, n };
	if (n >= rc.t.breakerCount) {
		b.trippedAt = at;
		cancelAll(rc);
		return { tripped: true, fresh: true, n };
	}
	return { tripped: false, fresh: false, n };
}

export function arm(rc: Env, id: string, ms: number) {
	rc.timers.get(id)?.();
	rc.timers.set(
		id,
		rc.timer(ms, () => {
			rc.timers.delete(id);
			attempt(rc, id).catch((e) => rc.d.log("recover-error", { threadId: id, error: String(e).slice(0, 200) }));
		}),
	);
}

/** Ends a pending retry without sending it, and logs why. */
export function standDown(rc: Env, threadId: string, p: Pending, why: string) {
	clearPending(rc, threadId);
	save(rc);
	rc.d.log("recover-stand-down", { threadId, runId: p.runId, kind: p.kind, why });
}

/** Why a pending retry must not go out, from the fresh read of the thread; `wake` is what the Steward is told when the retry was held back for lack of a read. */
type Hold = { why: string; wake?: string };

/** The fresh read of the thread against what the retry was scheduled for. */
function lookHold(p: Pending, instruction: string, look: RunLook): string | undefined {
	if (instruction !== p.instruction) return "someone wrote in the thread";
	if (look.waiting) return "the thread is waiting on a card, approval or question now";
	if (look.active) return "a run is active on the thread now";
	if (look.latestStatus !== "failed") return `the thread's newest run is ${look.latestStatus ?? "missing"}, not failed`;
	if (look.latestRunId && look.latestRunId !== p.runId) return "a newer run exists";
	return undefined;
}

/** The daemon's own view of the thread, read synchronously right before the ping, against the rules. */
function liveHold(rc: Env, live: ThreadState, children: number): string | undefined {
	if (live.status !== "failed") return `the thread is ${live.status}, not failed`;
	const stop = neverRetryThread(live, { stewardId: rc.d.stewardId(), decisionsId: rc.d.decisionsId(), children });
	if (stop) return stop;
	if (tripped(rc)) return "outage breaker is tripped";
	return undefined;
}

/** Whether the reads taken after the grace allow the retry: undefined when they do. Synchronous, so the state is read once more right before the ping. */
export function holdReason(
	rc: Env,
	threadId: string,
	p: Pending,
	reads: { instruction: string; children: number; look: RunLook | undefined },
): Hold | undefined {
	const { instruction, children, look } = reads;
	// A read that fails stands down too: the retry must never race a message or a state it could not see.
	if (instruction === "unknown" || !look)
		return {
			why:
				instruction === "unknown"
					? "the thread's messages could not be read"
					: "the thread could not be read again before the ping",
			wake: "the automatic retry was held back because the thread could not be read, so nothing has been retried",
		};
	const fromLook = lookHold(p, instruction, look);
	if (fromLook) return { why: fromLook };
	const live = rc.d.state(threadId);
	if (!live)
		return {
			why: "the daemon cannot see the thread",
			wake: "the automatic retry was held back because the daemon could not see the thread, so nothing has been retried",
		};
	const fromLive = liveHold(rc, live, children);
	return fromLive ? { why: fromLive } : undefined;
}

/** Puts a thread's counters back as they were before the attempt. */
export function restoreCounters(tr: ThreadRecord, before: Before) {
	tr.pings = before.pings;
	if (before.retried) tr.retried = before.retried;
	else delete tr.retried;
}

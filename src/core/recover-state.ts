/** Stalled-thread recovery: what handling a failure can be, what the engine gives recovery, and the state it keeps between ticks. */
import type { ThreadState } from "./adapter.ts";
import type { RunFailure, RunLook } from "./adapter-inspect.ts";
import type { JudgeAnswer, Trigger } from "./judge.ts";
import type { FailureKind, RecoverTiming, Verdict } from "./recover-classify.ts";

export type Handling =
	| { action: "retry-scheduled"; kind: FailureKind; at: number }
	/** Fall through to the ordinary failed wake. `note` says why the daemon did not retry. */
	| { action: "wake"; kind: FailureKind; note: string }
	/** A second failure: the judge's answer, for the Steward's wake. `ask` is true when the principal is needed. */
	| {
			action: "verdict";
			kind: FailureKind;
			backend: string;
			verdict: Verdict | "unjudged";
			reason: string;
			ask: boolean;
	  }
	/** The breaker tripped on this failure (`alarm`) or was already tripped. No wake. */
	| { action: "breaker"; kind: FailureKind; alarm: boolean; count: number }
	/** Already handled (the same run twice). Nothing to do. */
	| { action: "duplicate" };

export type RecoverDeps = {
	now?: () => number;
	/** Runs `fn` after `ms`; returns the function that cancels it. */
	setTimer?: (ms: number, fn: () => void) => () => void;
	stewardId: () => string | undefined;
	decisionsId: () => string | undefined;
	/** The newest state the daemon holds for a thread. */
	state: (threadId: string) => ThreadState | undefined;
	/** Running children and subagents of a thread. */
	children: (threadId: string) => Promise<number>;
	/** The backend's record of the thread's newest failure. Undefined: the adapter cannot say. */
	readFailure: (threadId: string) => Promise<RunFailure | undefined>;
	/** The id of the thread's latest instruction, "none" when it has none, "unknown" when it cannot be read. */
	instructionId: (threadId: string) => Promise<string>;
	/** A fresh read of the thread from the backend, taken right before a ping. Undefined: it cannot be read, and nothing is sent. */
	look: (threadId: string) => Promise<RunLook | undefined>;
	/** Where recovery's state is kept across restarts. Default: in memory only. */
	store?: RecoverStore;
	/** The one ping, as the daemon, in queue mode. A detail that starts "not sent: " means nothing was sent (src/adapters/t3/ping.ts NOT_SENT); any other failure may have been. */
	ping: (threadId: string, text: string, seed: string) => Promise<{ ok: boolean; detail: string }>;
	judge: (
		trigger: Trigger,
		brief: { system: string; user: string; verdicts: readonly string[] },
	) => Promise<JudgeAnswer>;
	/** Delivers the ordinary failed wake for a thread with a note: the fallback when a retry could not be made. */
	wake: (threadId: string, kind: FailureKind, note: string) => void;
	log: (event: string, data?: Record<string, unknown>) => void;
	timing?: Partial<RecoverTiming>;
};

type Failed = { runId: string; at: number; kind: FailureKind };
export type ThreadRecord = {
	/** The failures of this thread in its current unhealthy stretch, within the horizon. */
	failures: Failed[];
	/** Retry pings sent in this stretch. */
	pings: number;
	retried?: { runId: string; at: number; failure: RunFailure; kind: FailureKind };
	/** The judge has seen it: no more automatic retries until a turn completes. */
	judged?: boolean;
	pending?: {
		runId: string;
		kind: FailureKind;
		failure: RunFailure;
		instruction: string;
		due: number;
		/** Set by the write-ahead: the thread's counters exactly as they were before the attempt, so a refusal that sent nothing restores them, even after a restart. */
		attempt?: { pings: number; retried: { runId: string; at: number; failure: RunFailure; kind: FailureKind } | null };
	};
};
/** Everything recovery must remember across a restart. Plain JSON. */
export type RecoverState = {
	v: 1;
	handled: string[];
	threads: Record<string, ThreadRecord>;
	breaker: { failures: { at: number; kind: FailureKind }[]; trippedAt?: number; lastFailureAt: number };
};
export type RecoverStore = { load(): RecoverState | undefined; save(state: RecoverState): void };
export const freshState = (): RecoverState => ({
	v: 1,
	handled: [],
	threads: {},
	breaker: { failures: [], lastFailureAt: 0 },
});
export const memoryRecoverStore = (): RecoverStore => {
	let kept: RecoverState | undefined;
	return {
		load: () => kept,
		save: (s) => {
			kept = JSON.parse(JSON.stringify(s)) as RecoverState;
		},
	};
};

/**
 * The message id seed of a retry: the thread and the failed run's ordinal (T3's own, monotonic per thread), never a random value. A send
 * repeated after a restart carries the same id and T3 drops it; a later stretch of the same thread has a later ordinal, so it never collides.
 */
export const retrySeed = (threadId: string, f: Pick<RunFailure, "runId" | "ordinal">) =>
	`recover:${threadId}:${f.ordinal ?? f.runId}`;

/** What the daemon sends to retry. It says what happened and asks for nothing new. */
export const RETRY_TEXT =
	"[automatic retry] Your last run failed with a transient error and nobody has written here since. Continue from where it stopped.";
export const HANDLED_MAX = 500;

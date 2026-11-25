/** The adapter contract for reading a thread: why a run failed, its last message, the Steward's own probe and a snapshot of a server's threads. */

import type { TurnItem } from "../decide/decide.ts";
import type { InstructionRead } from "../ops/history.ts";
import type { WaitingRead } from "./adapter-waiting.ts";

/**
 * Reads of one thread, made on demand when a wake is being built. A read that fails rejects; the core logs it and carries
 * on with a neutral value (no excerpt, no question, no subagents). `instruction` never rejects: its state says what happened.
 */
/**
 * Why a run failed, as the backend records it. `class`, `code` and `message` are the backend's own words; src/core/ops/recover.ts reads
 * them in code and never asks a model what kind of failure it was. `interrupted` is true when someone stopped the run: a stop is not an outage.
 */
export type RunFailure = {
	runId: string /** The run's ordinal in its thread: monotonic, so a retry's message id never repeats across stretches. */;
	ordinal?: number;
	class?: string;
	code?: string;
	message: string;
	retryable?: boolean;
	resetAt?: string;
	interrupted?: boolean;
};

/** What a fresh read of a thread shows, taken right before a ping: its newest run and whether anything is going or waiting. */
export type RunLook = {
	latestRunId?: string;
	latestStatus?: string /** a run is queued, starting, running or waiting */;
	active: boolean /** a card, approval, secret or question is open */;
	waiting: boolean;
};

/** A thread's last finished assistant message: its id, its text, and when it finished (ISO). */
/**
 * A thread's last finished assistant message. `previous` is the user message before it, from the same read, with who wrote it: `human`
 * (the operator) or `agent` (another agent or a tool sending into the thread); absent when there is none or the adapter cannot say. The
 * idle-thread classifier reads it (src/core/classifier/); nothing else does.
 */
export type LastAssistant = {
	id: string;
	text: string;
	at: string;
	previous?: { by: "human" | "agent"; text: string };
};

export type Inspector = {
	/**
	 * The text of the thread's last finished assistant message, or "" when there is none or it can't be read.
	 * `runId` keeps the excerpt on that completed run (queued handoff, issue #74).
	 */
	lastMessage(threadId: string, runId?: string): Promise<string>;
	/**
	 * The thread's last finished assistant message with its own id and the time it finished (ISO), or undefined when there is none.
	 * The idle-parents sweep check (src/core/decide/idle-parents.ts) reads it. Absent: that check cannot see this adapter's threads.
	 */
	lastAssistant?(threadId: string): Promise<LastAssistant | undefined>;
	/** What the thread is waiting on now. Never rejects; only an `ok: true` read may be believed (see `WaitingRead`). */
	waiting(threadId: string): Promise<WaitingRead>;
	/**
	 * When the principal last wrote in the thread, in epoch milliseconds, if that was at or after `since`; undefined when they did not write
	 * since then. A message from a machine (an agent, a tool, the daemon's own posts) is not the principal's. It rejects when it cannot tell,
	 * and the core then acts as if the principal were not there. Absent: the adapter cannot say, and `activeHold` never holds its threads' cards.
	 */
	principalLastWrite?(threadId: string, since: number): Promise<number | undefined>;
	/** Counts local operator-authored messages in [from, to), or rejects if the window cannot be read in full. No text leaves the adapter. */
	countPrincipalMessages?(threadId: string, span: { from: number; to: number }): Promise<number>;
	/** Subagents the thread itself runs (not separate threads): their completion wakes it. */
	runningSubagents(threadId: string): Promise<number>;
	/**
	 * The thread's latest instruction, past the backend's window if need be (src/core/ops/history.ts says what the state means).
	 * `runId` scopes the read to that completed run so a later successor cannot replace its report (issue #74).
	 */
	instruction(threadId: string, runId?: string): Promise<InstructionRead>;
	/**
	 * Every run on the thread (id, ordinal, status). Absent: the adapter has no runs reader (explicit handoff
	 * compatibility path). A capable reader that fails must reject, not return an empty list as success.
	 */
	runs?(threadId: string): Promise<{ id?: string; ordinal?: number; status?: string }[]>;
	/**
	 * One coherent handoff observation (runs + items together). Preferred over separate `runs` + `instruction` reads so
	 * ownership is not judged across mismatched snapshots. Absent: the core falls back to those separate reads.
	 */
	handoffSnapshot?(
		threadId: string,
	): Promise<{ runs: { id?: string; ordinal?: number; status?: string }[]; items: TurnItem[] }>;
	/** The newest failed run of the thread and its error. Absent: the adapter cannot say, and stalled-thread recovery stays off for its threads. */
	failure?(threadId: string): Promise<RunFailure | undefined>;
	/** The thread read again from the backend itself (never from what the watcher last saw), right before a retry ping. Absent: recovery stays off for its threads. */
	look?(threadId: string): Promise<RunLook | undefined>;
	/**
	 * The thread's latest run (by ordinal) and the turn items in the same projection, for the undelivered-message check.
	 * Absent: that check cannot see this adapter's threads.
	 */
	latestRun?(threadId: string): Promise<
		| {
				run: {
					id?: string;
					ordinal?: number;
					status?: string;
					startedAt?: string;
					completedAt?: string;
					requestedAt?: string;
					executedModel?: string | null;
					userMessageId?: string;
				};
				items: { type?: string; id?: string; itemId?: string; status?: string; updatedAt?: string }[];
		  }
		| undefined
	>;
};

// ---- post ----------------------------------------------------------------------------------------

/** The newest exact context observation, or why the adapter cannot provide one. Token totals and earlier turns are not observations. */
export type ContextReading = { tokens: number; window?: number; source: string; at: string } | { unknown: string };

/** What an adapter can tell about a guarded thread, read once a minute. */
export type StewardProbe = {
	context?: ContextReading;
	/** Ordinals of the latest consecutive completed provider turns lacking a projected size, oldest last. */
	unknownTurns?: readonly number[];
	/** Latest completed provider turn on the active provider thread, when readable. */
	completedTurn?: number;
	/** The completed turn before it, even if provider turn ordinals have gaps. */
	previousCompletedTurn?: number;
	/** Historical measurements may have come from outside the projection. Only observed turns count in that case. */
	partialContextHistory?: boolean;
	/** False means the provider cannot take a compaction command. Absence means the adapter cannot say. */
	canCompact?: boolean;
	/** False when a request that never completed must be treated as failed instead of being retried. */
	retryLostCompact?: boolean;
	/** A stable identity for the active provider thread, for deduplicating hand-offs. */
	contextSession?: string;
	/** The Steward's context size in tokens, when known: the newest turn's, never an older sample. */
	contextTokens?: number;
	/** The ordinal of the turn `contextTokens` was read from. */
	contextTurn?: number;
	/** How many compactions of the Steward's thread have completed (the daemon's, the harness's own and manual ones alike), when readable. */
	compactions?: number;
	/** The ordinal of the turn that ran the newest compaction; that turn's own size is the size after it. */
	compactionTurn?: number;
	/** False when the backend's own record of the Steward could not be read this time. */
	readable: boolean;
	/** Set when wakes are queued and nothing in the Steward's thread has moved: the alarm to raise. */
	stalled?: { title: string; summary: string };
	/** Why a compaction must not be sent now, or undefined when one may go. */
	compactBlocked?: string;
};

/** A transcript the health check can measure: Claude Code's JSONL for the Steward's session. */
export type Transcript = {
	path: string;
	session: string;
	thread: string;
	/** Names a tool call that reads another thread by the thread it reads (see MeasureOptions in steward-health.ts). */
	threadReadKey?: (tool: string, input: Record<string, unknown>) => string | undefined;
};

// ---- the adapter ---------------------------------------------------------------------------------

/** What a snapshot knows of one thread. */
type ThreadFactsRow = {
	id: string;
	archived: boolean;
	settled: boolean;
	pendingRequestId: string | null;
	status: string;
};
/** A whole read of an adapter's server. `complete` is false when the answer may be partial, and then it says nothing about a thread it lacks. */
export type ThreadSnapshot = { complete: boolean; threads: ThreadFactsRow[] };

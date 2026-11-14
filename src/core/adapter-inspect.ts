/** The adapter contract for reading a thread: why a run failed, its last message, the Steward's own probe and a snapshot of a server's threads. */

import type { WaitingRead } from "./adapter-waiting.ts";
import type { InstructionRead } from "./history.ts";

/**
 * Reads of one thread, made on demand when a wake is being built. A read that fails rejects; the core logs it and carries
 * on with a neutral value (no excerpt, no question, no subagents). `instruction` never rejects: its state says what happened.
 */
/**
 * Why a run failed, as the backend records it. `class`, `code` and `message` are the backend's own words; src/core/recover.ts reads
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
	/** The text of the thread's last finished assistant message, or "" when there is none or it can't be read. */
	lastMessage(threadId: string): Promise<string>;
	/**
	 * The thread's last finished assistant message with its own id and the time it finished (ISO), or undefined when there is none.
	 * The idle-parents sweep check (src/core/idle-parents.ts) reads it. Absent: that check cannot see this adapter's threads.
	 */
	lastAssistant?(threadId: string): Promise<LastAssistant | undefined>;
	/** What the thread is waiting on now. Never rejects; only an `ok: true` read may be believed (see `WaitingRead`). */
	waiting(threadId: string): Promise<WaitingRead>;
	/** Subagents the thread itself runs (not separate threads): their completion wakes it. */
	runningSubagents(threadId: string): Promise<number>;
	/** The thread's latest instruction, past the backend's window if need be (src/core/history.ts says what the state means). */
	instruction(threadId: string): Promise<InstructionRead>;
	/** The newest failed run of the thread and its error. Absent: the adapter cannot say, and stalled-thread recovery stays off for its threads. */
	failure?(threadId: string): Promise<RunFailure | undefined>;
	/** The thread read again from the backend itself (never from what the watcher last saw), right before a retry ping. Absent: recovery stays off for its threads. */
	look?(threadId: string): Promise<RunLook | undefined>;
};

// ---- post ----------------------------------------------------------------------------------------

/** What an adapter can tell about the Steward's own thread, read once a minute. */
export type StewardProbe = {
	/** The Steward's context size in tokens, when known. */
	contextTokens?: number;
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

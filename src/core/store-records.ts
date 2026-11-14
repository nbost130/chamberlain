/** The classifier's dispositions and the Steward's token usage per wake: the types and the stores they are kept in. */

// ---- the idle-thread classifier's dispositions (migration 13) ------------------------------------

/** What the classifier decided for one idle thread. `unknown` is a classification that failed: reported as if unclassified. */
export type DispositionAction = "escalate" | "nudge" | "settle" | "ignore" | "unknown";
/** A cache key: one thread, one last message, one bank version. */
export type DispositionKey = { server: string; threadId: string; messageHash: string; bankVersion: string };
/**
 * One row of `thread_dispositions`. It holds no message text: `answers` (question id to probability) and `reasons` (the ids that
 * decided the action) explain the decision, and the text stays in the thread.
 */
export type Disposition = DispositionKey & {
	classifiedAt: number;
	provider: "rules" | "jev" | "haiku";
	model: string | null;
	mode: "shadow" | "live";
	action: DispositionAction;
	reasons: string[];
	answers: Record<string, number>;
	idleMinutes: number;
	sentChars: number;
	redactions: number;
	inputTokens: number | null;
	costUsd: number | null;
	latencyMs: number | null;
	/** Set exactly when `action` is unknown. */
	error: string | null;
	feedback: "right" | "wrong" | null;
	correctedAction: Exclude<DispositionAction, "unknown"> | null;
};
export type DispositionWrite = Omit<Disposition, "feedback" | "correctedAction">;
export interface DispositionStore {
	get(k: DispositionKey): Disposition | undefined;
	/** Writes one classification attempt: a new row, or the row for its key replaced, keeping any feedback it had. */
	put(d: DispositionWrite): void;
	/** A cached row decided again from its stored answers (the idle time moved, or the combine settings changed). No new call. */
	redecide(
		k: DispositionKey,
		o: {
			action: Exclude<DispositionAction, "unknown">;
			reasons: string[];
			idleMinutes: number;
			mode: "shadow" | "live";
		},
	): void;
	/** Calls made since `since` (ms) by these providers, and what they cost: the daily budget is summed from here. */
	usage(since: number, providers: readonly string[]): { calls: number; usd: number };
	/** Marks a disposition right or wrong, with the action it should have had. False when there is no such row. */
	feedback(k: DispositionKey, feedback: "right" | "wrong", corrected?: Exclude<DispositionAction, "unknown">): boolean;
	/** Deletes rows classified before `before`, except rows with feedback (the next evaluation set). */
	prune(before: number): number;
}

// ---- the Steward's token usage per wake ------------------------------------------------------------

/**
 * One segment of a Steward transcript (src/core/steward-tokens.ts): one wake, or the start prompt, a compaction, a T3 notice or a message,
 * with every model request until the next. The API's four `usage` fields summed over its distinct requests, and the context size (input plus
 * cache read plus cache write) at its first and last request. Never any text.
 */
export type WakeUsage = {
	session: string;
	/** The wake's delivery id; a wake from before delivery ids, or any other prompt, is `uuid:<its row's uuid>`. A repeat in one session gets `#2`, `#3`. */
	wakeKey: string;
	/** The wake's kind from its header (`turn_ended`, `needs_input`, `answer`, `digest`, `sweep`, ...), or `start`, `compact`, `notice`, `message`, `preamble`. */
	kind: string;
	/** For a sweep: `full` (time for a full supervision sweep) or `findings` (only the listed checks). */
	variant?: string;
	deliveryId?: string;
	startedAt: number;
	endedAt: number;
	requests: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	contextStart?: number;
	contextEnd?: number;
	contextPeak?: number;
	/** Compactions inside the segment (`compact_boundary` rows). */
	compactions: number;
};
export interface UsageStore {
	/** Inserts or replaces each row by (session, wake key), in one transaction. A rerun over the same transcript writes the same rows. */
	upsert(rows: WakeUsage[]): void;
	/** Rows started at or after `since`, of one session if given, oldest first. */
	list(q?: { since?: number; session?: string }): WakeUsage[];
}

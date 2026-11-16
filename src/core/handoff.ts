/**
 * Queued-handoff confirmation (issue #74): a LIVE→LIVE wake is a small record (completed run, causing successor)
 * confirmed only from one coherent observation. Fail closed when a capable reader cannot certify completion.
 */
import type { TurnItem } from "./decide.ts";

export type HandoffRun = { id?: string; ordinal?: number; status?: string };

/** Carried across the debounce: which run ended and which successor caused the LIVE→LIVE sighting. */
export type HandoffRecord = {
	threadId: string;
	runId: string;
	successorId: string;
};

export type HandoffObservation =
	| { kind: "unsupported" }
	| { kind: "failed"; error: string }
	| { kind: "ok"; runs: HandoffRun[]; items: TurnItem[] };

export type HandoffDecision =
	| { action: "go"; intervening: string[] }
	| { action: "skip"; reason: "skip-not-completed" | "skip-human-successor" }
	| { action: "retry"; reason: "skip-handoff-unconfirmed" };

/** The completed-run id in a `turn_ended` key, or undefined when the key is a timestamp (no run named). */
export function endedRunId(key: string): string | undefined {
	// Thread ids can contain colons (`mcp:launch:…`), so match the trailing `:ended:` segment only.
	const m = /:ended:(.+)$/.exec(key);
	if (!m?.[1]) return undefined;
	return /^\d{12,}$/.test(m[1]) ? undefined : m[1];
}

/** Items that belong to one run (interrupt retention is not that run's start). */
export const itemsForRun = (items: TurnItem[], runId: string) =>
	items.filter((i) => i.runId === runId && i.type !== "run_interrupt_request");

/** The last completed assistant message of one run only — never an older run's final. */
export function lastCompletedForRun(
	items: { type?: string; status?: string; text?: string; runId?: string }[],
	runId: string,
): string {
	const last = [...items]
		.reverse()
		.find((i) => i.runId === runId && i.type === "assistant_message" && i.status === "completed");
	return String(last?.text ?? "");
}

const runStart = (items: TurnItem[], runId: string): TurnItem | undefined =>
	items.find((i) => i.runId === runId && i.type !== "run_interrupt_request");

const humanStarted = (items: TurnItem[], runId: string) => runStart(items, runId)?.createdBy === "user";

const newest = (runs: HandoffRun[]) =>
	runs
		.filter((r) => r.id)
		.reduce<HandoffRun | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);

/**
 * Completed runs strictly between `fromId` and `untilId` (or the newest run when `untilId` is omitted).
 * The upper bound need not be LIVE: a successor that finished before debounce still ends the interval.
 */
export function interveningCompleted(runs: HandoffRun[], fromId: string, untilId?: string): string[] {
	const fromOrd = runs.find((r) => r.id === fromId)?.ordinal;
	const untilOrd = (untilId ? runs.find((r) => r.id === untilId) : newest(runs))?.ordinal;
	if (fromOrd === undefined || untilOrd === undefined) return [];
	return runs
		.filter((r) => r.id && r.status === "completed" && (r.ordinal ?? -1) > fromOrd && (r.ordinal ?? -1) < untilOrd)
		.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
		.map((r) => r.id as string);
}

/**
 * Confirm a named-run end from one observation.
 * - No handoff record: idle-gap / ordinary end — go (completion was the thread leaving LIVE).
 * - Queued handoff record: require `completed`, reject a human causing-successor or human tip, reconcile the interval.
 * - Capable reader failed or returned no runs: retry (fail closed, leave unconfirmed).
 * - `unsupported`: adapter has no runs reader — explicit compatibility admit.
 * `currentLatest` is the watcher's newest run id after the observation (catches a successor that arrived mid-read).
 */
export function confirmHandoff(
	obs: HandoffObservation,
	runId: string,
	record: HandoffRecord | undefined,
	currentLatest?: string | null,
): HandoffDecision {
	if (!record) return { action: "go", intervening: [] };
	if (obs.kind === "unsupported") return { action: "go", intervening: [] };
	if (obs.kind === "failed" || !obs.runs.length) return { action: "retry", reason: "skip-handoff-unconfirmed" };
	const { runs, items } = obs;
	if (runs.find((r) => r.id === runId)?.status !== "completed") return { action: "skip", reason: "skip-not-completed" };
	const tip = newest(runs);
	const ownership = [record.successorId, tip?.id, currentLatest ?? undefined].filter(
		(id): id is string => Boolean(id) && id !== runId,
	);
	for (const id of new Set(ownership)) {
		if (humanStarted(items, id)) return { action: "skip", reason: "skip-human-successor" };
	}
	const untilId =
		tip?.id && (tip.ordinal ?? -1) >= (runs.find((r) => r.id === record.successorId)?.ordinal ?? -1)
			? tip.id
			: record.successorId;
	return { action: "go", intervening: interveningCompleted(runs, runId, untilId) };
}

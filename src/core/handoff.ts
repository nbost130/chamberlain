/**
 * Queued-handoff helpers (issue #74): a LIVE→LIVE run change is only a report when the named run completed
 * successfully and the successor was not started by a human. Reads for that wake stay scoped to the named run.
 */
import { LIVE, type TurnItem } from "./decide.ts";

export type HandoffRun = { id?: string; ordinal?: number; status?: string };

/** The completed-run id in a `turn_ended` key, or undefined when the key is a timestamp (no run named). */
export function endedRunId(key: string): string | undefined {
	// Thread ids can contain colons (`mcp:launch:…`), so match the trailing `:ended:` segment only.
	const m = /:ended:(.+)$/.exec(key);
	if (!m?.[1]) return undefined;
	// Idle-gap keys without a backend run id still use Date.now() (13+ digits).
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

/** The first non-interrupt item of a run: who started it. */
const runStart = (items: TurnItem[], runId: string): TurnItem | undefined =>
	items.find((i) => i.runId === runId && i.type !== "run_interrupt_request");

/** A human's own message started this run (web/mobile), not a queued Steward MCP instruction. */
const humanStarted = (items: TurnItem[], runId: string) => runStart(items, runId)?.createdBy === "user";

/**
 * Whether a handoff wake for `runId` may go. `stillLive` means the thread never went idle (queued successor).
 * Without a runs list the gate cannot judge and stays open (idle-gap adapters that name no runs).
 */
export function handoffAllowed(
	runs: HandoffRun[] | undefined,
	items: TurnItem[],
	runId: string,
	stillLive: boolean,
): "ok" | "skip-not-completed" | "skip-human-successor" {
	if (!runs?.length) return "ok";
	const mine = runs.find((r) => r.id === runId);
	if (mine?.status !== "completed") return "skip-not-completed";
	if (!stillLive) return "ok";
	const live = runs
		.filter((r) => r.id && LIVE.has(String(r.status)))
		.reduce<HandoffRun | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
	if (live?.id && humanStarted(items, live.id)) return "skip-human-successor";
	return "ok";
}

/** Completed runs strictly between `fromId` and the newest LIVE run — skipped ordinals the shell never named. */
export function interveningCompleted(runs: HandoffRun[], fromId: string): string[] {
	const from = runs.find((r) => r.id === fromId);
	const live = runs
		.filter((r) => r.id && LIVE.has(String(r.status)))
		.reduce<HandoffRun | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
	const fromOrd = from?.ordinal;
	const liveOrd = live?.ordinal;
	if (fromOrd === undefined || liveOrd === undefined) return [];
	return runs
		.filter((r) => r.id && r.status === "completed" && (r.ordinal ?? -1) > fromOrd && (r.ordinal ?? -1) < liveOrd)
		.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
		.map((r) => r.id as string);
}

/**
 * Why T3's newest failed run failed, from the thread's projection. T3 records a failed run's error as a turn item of type
 * `error` carrying the run's id and a `failure` object (`class`, `code`, `message`, `retryable`, `resetAt`), and an interrupt as a
 * `run_interrupt_request` item with the run's id. Both are read here and nowhere else; the core classifies them (src/core/recover.ts).
 */
import type { RunFailure, RunLook } from "../../core/adapter.ts";

type Run = { id?: string; ordinal?: number; status?: string };
type Item = { type?: string; runId?: string; failure?: { class?: string; code?: string; message?: string; retryable?: boolean; resetAt?: string } };

const ACTIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/** Pure: what the projection shows right now: the newest run and its status, whether any run is going, and whether any card is open. */
export function lookOf(runs: Run[], items: { status?: string }[]): RunLook {
	const newest = runs.filter((r) => r.id).reduce<Run | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
	return {
		...(newest?.id ? { latestRunId: newest.id } : {}),
		...(newest?.status ? { latestStatus: newest.status } : {}),
		active: runs.some((r) => ACTIVE.has(String(r.status))),
		waiting: items.some((i) => i.status === "waiting"),
	};
}

/** Pure: the newest failed run's failure, or undefined when no run of the thread failed. */
export function failureOf(runs: Run[], items: Item[]): RunFailure | undefined {
	const failed = runs.filter((r) => r.status === "failed" && r.id).reduce<Run | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
	if (!failed?.id) return undefined;
	const err = [...items].reverse().find((i) => i.type === "error" && i.runId === failed.id);
	const interrupted = items.some((i) => i.type === "run_interrupt_request" && i.runId === failed.id);
	return {
		runId: failed.id,
		...(typeof failed.ordinal === "number" ? { ordinal: failed.ordinal } : {}),
		...(err?.failure?.class ? { class: err.failure.class } : {}),
		...(err?.failure?.code ? { code: err.failure.code } : {}),
		message: String(err?.failure?.message ?? ""),
		...(typeof err?.failure?.retryable === "boolean" ? { retryable: err.failure.retryable } : {}),
		...(err?.failure?.resetAt ? { resetAt: err.failure.resetAt } : {}),
		...(interrupted ? { interrupted: true } : {}),
	};
}

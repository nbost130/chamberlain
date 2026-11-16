/**
 * Pure: parked prepare-pr runs → sweep check findings (parseCheckOutput shape).
 * dedup_key = prepare-pr:<runId>; settled-mismatch = prepare-pr:settled-mismatch:<runId>.
 */
import type { Finding } from "../items/source.ts";
import type { AxiParkedRun } from "./axi-parse.ts";
import { isOneWayDoorStep, ONE_WAY_DOOR_URGENT_MS, OTHER_GATE_WAKE_MS } from "./thresholds.ts";

export type PreparePrLink = {
	threadId: string;
	runId: string;
	repo: string;
	startedAt: number;
	clearedAt: number | null;
};

export type ParkedFindingKind = "one-way-urgent" | "other-gate" | null;

function resolveParkedMs(run: AxiParkedRun, nowMs: number, parkedSinceMs?: number | null): number | null {
	if (run.parkedMs != null) return run.parkedMs;
	if (parkedSinceMs != null && Number.isFinite(parkedSinceMs)) return Math.max(0, nowMs - parkedSinceMs);
	return null;
}

/** Pure: which wake class this parked run is, given thresholds and now. */
export function parkedKind(run: AxiParkedRun, nowMs: number, parkedSinceMs?: number | null): ParkedFindingKind {
	if (run.gateStatus !== "awaiting_approval" || !run.gateStep) return null;
	const parkedMs = resolveParkedMs(run, nowMs, parkedSinceMs);
	if (parkedMs == null) return null;
	if (isOneWayDoorStep(run.gateStep)) return parkedMs > ONE_WAY_DOOR_URGENT_MS ? "one-way-urgent" : null;
	return parkedMs > OTHER_GATE_WAKE_MS ? "other-gate" : null;
}

function parkedSeconds(run: AxiParkedRun, nowMs: number, parkedSinceMs?: number | null): number {
	return Math.floor((resolveParkedMs(run, nowMs, parkedSinceMs) ?? 0) / 1000);
}

function parkedFindingText(repo: string, run: AxiParkedRun, seconds: number, urgent: boolean): string {
	const step = run.gateStep ?? "unknown";
	const body = `${repo} branch ${run.branch} runId ${run.runId} head ${run.head} parked at ${step} awaiting_approval for ${seconds}s`;
	return urgent ? `[URGENT] ${body}` : body;
}

function settledMismatchText(repo: string, run: AxiParkedRun, threadId: string, seconds: number): string {
	const step = run.gateStep ?? run.status;
	const state = run.gateStatus ?? run.status;
	return `[URGENT] ${repo} linked thread ${threadId} is settled but runId ${run.runId} head ${run.head} is still ${state} at ${step} (${seconds}s); prepare-pr still open`;
}

function runStillOpen(run: AxiParkedRun): boolean {
	return run.gateStatus === "awaiting_approval" || run.status === "running" || run.status === "awaiting_approval";
}

function parkedFinding(o: {
	repo: string;
	run: AxiParkedRun;
	nowMs: number;
	since: number | null;
}): Finding | undefined {
	const kind = parkedKind(o.run, o.nowMs, o.since);
	if (!kind) return undefined;
	const urgent = kind === "one-way-urgent";
	return {
		dedupKey: `prepare-pr:${o.run.runId}`,
		text: parkedFindingText(o.repo, o.run, parkedSeconds(o.run, o.nowMs, o.since), urgent),
		repeatIntervalMs: urgent ? ONE_WAY_DOOR_URGENT_MS : OTHER_GATE_WAKE_MS,
		subject: { kind: "run", id: o.run.runId },
	};
}

function mismatchFinding(o: {
	repo: string;
	link: PreparePrLink;
	run: AxiParkedRun;
	nowMs: number;
	since: number | null;
}): Finding | undefined {
	if (o.link.clearedAt != null || !runStillOpen(o.run)) return undefined;
	return {
		dedupKey: `prepare-pr:settled-mismatch:${o.run.runId}`,
		text: settledMismatchText(o.repo, o.run, o.link.threadId, parkedSeconds(o.run, o.nowMs, o.since)),
		repeatIntervalMs: ONE_WAY_DOOR_URGENT_MS,
		subject: { kind: "run", id: o.run.runId },
	};
}

function parkedFindingsFor(
	repo: string,
	runs: readonly AxiParkedRun[],
	nowMs: number,
	parkedSinceByRun?: ReadonlyMap<string, number>,
): Finding[] {
	const out: Finding[] = [];
	for (const run of runs) {
		const f = parkedFinding({
			repo,
			run,
			nowMs,
			since: parkedSinceByRun?.get(run.runId) ?? null,
		});
		if (f) out.push(f);
	}
	return out;
}

function mismatchFindingsFor(o: {
	repo: string;
	runs: readonly AxiParkedRun[];
	nowMs: number;
	links: readonly PreparePrLink[];
	settled: ReadonlySet<string>;
	parkedSinceByRun?: ReadonlyMap<string, number>;
	already: Set<string>;
}): Finding[] {
	const out: Finding[] = [];
	const byId = new Map(o.runs.map((r) => [r.runId, r]));
	for (const link of o.links) {
		if (!o.settled.has(link.threadId)) continue;
		const run = byId.get(link.runId);
		if (!run) continue;
		const f = mismatchFinding({
			repo: o.repo,
			link,
			run,
			nowMs: o.nowMs,
			since: o.parkedSinceByRun?.get(run.runId) ?? null,
		});
		if (!f || o.already.has(f.dedupKey)) continue;
		o.already.add(f.dedupKey);
		out.push(f);
	}
	return out;
}

/** Pure: findings for one repo's parked runs + optional settled mismatches. */
export function preparePrFindings(o: {
	repo: string;
	runs: readonly AxiParkedRun[];
	nowMs: number;
	parkedSinceByRun?: ReadonlyMap<string, number>;
	links?: readonly PreparePrLink[];
	settledThreadIds?: ReadonlySet<string>;
}): Finding[] {
	const parked = parkedFindingsFor(o.repo, o.runs, o.nowMs, o.parkedSinceByRun);
	const already = new Set(parked.map((f) => f.dedupKey));
	if (!o.settledThreadIds || !o.links?.length) return parked;
	return [
		...parked,
		...mismatchFindingsFor({
			repo: o.repo,
			runs: o.runs,
			nowMs: o.nowMs,
			links: o.links,
			settled: o.settledThreadIds,
			already,
			...(o.parkedSinceByRun ? { parkedSinceByRun: o.parkedSinceByRun } : {}),
		}),
	];
}

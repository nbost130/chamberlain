/**
 * How the overhead numbers read: the table `chamberlain overhead` prints, the one-line summary the Decisions view shows, and the summary kept
 * in state. Numbers only; no text of a wake or a transcript reaches any of them. A number is one of three things and says which: a value, "not
 * configured" (the operator has not asked for it) or "unavailable" (asked for, and the read failed).
 */
import type { OverheadReport, Status } from "./collect.ts";
import { DAY_MS, HOUR_MS } from "./config.ts";
import { fleetLines, managedLine, managedLines, pct, summarizeManaged, usd } from "./format-managed.ts";
import type { WindowMetrics } from "./metrics.ts";
import { isHeld, type OverheadState, type OverheadSummary } from "./trigger.ts";

const day = (ms: number) => new Date(ms).toISOString().slice(5, 10);

/** A span as a short label: whole days from two days up ("7 d"), hours below that ("24 h", "6 h"). */
const spanLabel = (ms: number): string =>
	ms >= 2 * DAY_MS && ms % DAY_MS === 0 ? `${ms / DAY_MS} d` : `${+(ms / HOUR_MS).toFixed(1)} h`;

/** The value of a PR-derived number, or why there is none. */
const prValue = (status: Status, v: string | undefined): string =>
	status === "not-configured" ? "not configured" : (v ?? "unavailable");

/** The numbers kept in state after each measurement. */
export function summarize(r: OverheadReport): OverheadSummary {
	const s: OverheadSummary = {
		at: r.at,
		windowLabel: spanLabel(r.windowMs),
		trailingLabel: spanLabel(r.baselineMs),
		prStatus: r.prStatus,
		fleetStatus: r.fleetStatus,
		crossings: r.crossings.map((c) => c.detail),
		unavailable: r.unavailable,
	};
	if (r.day.costPerPr !== undefined) s.costPerPrDay = r.day.costPerPr;
	if (r.trailing.costPerPr !== undefined) s.costPerPrTrailing = r.trailing.costPerPr;
	if (r.day.prs !== undefined) s.prsDay = r.day.prs;
	if (r.day.stewardUsd !== undefined) s.stewardUsdDay = r.day.stewardUsd;
	if (r.day.noopRate !== undefined) s.noopRate = r.day.noopRate;
	if (r.spendShare !== undefined) s.spendShare = r.spendShare;
	if (r.stewardShare !== undefined) s.stewardShare = r.stewardShare;
	s.managed = summarizeManaged(r);
	return s;
}

/** The headline overhead share with the Steward-only share beside it, or why there is none. */
const shareText = (status: Status, overhead: number | undefined, steward: number | undefined): string => {
	if (status === "not-configured") return "not configured";
	if (overhead === undefined) return "unavailable";
	return `${pct(overhead)} (Steward only ${pct(steward)})`;
};

/** The one line the Decisions view shows. */
export function summaryLine(s: OverheadSummary): string {
	const perPr = (v: number | undefined) => prValue(s.prStatus, v === undefined ? undefined : usd(v));
	return [
		`${perPr(s.costPerPrDay)}/PR ${s.windowLabel}`,
		`${perPr(s.costPerPrTrailing)}/PR ${s.trailingLabel}`,
		`${prValue(s.prStatus, s.prsDay === undefined ? undefined : String(s.prsDay))} PRs merged`,
		`Steward ${usd(s.stewardUsdDay)}`,
		`no-op ${pct(s.noopRate)}`,
		`overhead share ${shareText(s.fleetStatus, s.spendShare, s.stewardShare)}`,
		...(s.managed ? [managedLine(s.managed)] : []),
	].join(" · ");
}

/** A window's cost per PR as shown: why there is none, or the figure. A window with no usage rows was not measured, so it is not shown as $0. */
const perPr = (w: WindowMetrics, status: Status) => {
	if (status === "not-configured") return "not configured";
	if (w.turns === 0) return "no usage data";
	return w.prs === 0 ? "no PR merged" : usd(w.costPerPr);
};
const mode = (m: string) => (m === "trigger" ? "triggers" : "report only");

/** How the share is judged: a limit when it triggers, a target when it is only reported with one set. */
const shareMode = (t: { mode: string; threshold?: number }): string =>
	t.mode === "trigger"
		? `triggers, limit ${pct(t.threshold)}`
		: `report only${t.threshold === undefined ? "" : `, target at most ${pct(t.threshold)}`}`;

/** What `chamberlain overhead` prints. */
export function formatOverhead(r: OverheadReport): string {
	const d = r.day;
	const W = spanLabel(r.windowMs);
	const B = spanLabel(r.baselineMs);
	const cp = r.limits.costPerPr;
	const nr = r.limits.noopRate;
	const prs = (w: WindowMetrics) => prValue(r.prStatus, w.prs === undefined ? undefined : String(w.prs));
	const out = [
		`Overhead, rolling ${W} to ${new Date(r.at).toISOString().slice(0, 16)}Z  (Steward priced as ${r.model ?? "unknown"}, ${r.cacheWrite} cache writes)`,
		"",
		`  cost per merged PR   ${W} ${perPr(d, r.prStatus).padEnd(14)} ${B} ${perPr(r.trailing, r.prStatus).padEnd(14)} ${mode(cp.mode)}${cp.limitUsd === undefined ? "" : `, limit ${usd(cp.limitUsd)}`}`,
		`  PRs merged           ${W} ${prs(d).padEnd(14)} ${B} ${prs(r.trailing)}`,
		`  Steward spend        ${W} ${usd(d.stewardUsd).padEnd(14)} ${B} ${usd(r.trailing.stewardUsd)}   (classifier ${usd(d.classifierUsd)} in ${W})`,
		`  no-op wake rate      ${W} ${pct(d.noopRate).padEnd(14)} ${B} ${pct(r.trailing.noopRate).padEnd(14)} ${mode(nr.mode)}${nr.threshold === undefined ? "" : `, limit ${pct(nr.threshold)}`}  (${d.noop} of ${d.measured} wakes measured, ${d.wakes} wakes)`,
		`  cost per useful wake ${W} ${usd(d.costPerUsefulWake).padEnd(14)} ${B} ${usd(r.trailing.costPerUsefulWake)}`,
		`  overhead share       ${W} ${shareText(r.fleetStatus, r.spendShare, r.stewardShare)}  (${shareMode(r.limits.spendShare)})`,
	];
	out.push(...managedLines(r, W));
	out.push(...fleetLines(r));
	out.push("", `  trend (${W} windows)    day     PRs   $/PR      no-op   Steward`);
	for (const w of r.trend)
		out.push(
			`                         ${day(w.to - 1)}  ${prs(w).padStart(4)}  ${perPr(w, r.prStatus).padEnd(13)} ${pct(w.noopRate).padEnd(9)} ${usd(w.stewardUsd)}`,
		);
	out.push("");
	if (r.crossings.length) for (const c of r.crossings) out.push(`  CROSSED: ${c.detail}`);
	else out.push("  No limit crossed.");
	for (const u of r.notConfigured) out.push(`  NOT CONFIGURED: ${u}`);
	for (const u of r.unavailable) out.push(`  UNAVAILABLE: ${u}`);
	return out.join("\n");
}

/** What the Decisions view's payload carries: the last measurement's line, what it crossed and the investigation open now. Null before the first measurement. */
export type OverheadView = { at: string; line: string; crossed: string[]; unavailable: string[]; open: string | null };

export function overheadView(state: OverheadState): OverheadView | null {
	if (!state.last) return null;
	return {
		at: new Date(state.last.at).toISOString(),
		line: summaryLine(state.last),
		crossed: state.last.crossings,
		unavailable: state.last.unavailable,
		open: state.investigations.find(isHeld)?.id ?? null,
	};
}

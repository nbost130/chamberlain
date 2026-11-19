/** How the managed overhead ratio reads: its lines in the `chamberlain overhead` table, and the short form in the Decisions view's line. */
import type { OverheadReport } from "./collect.ts";
import type { ManagedSummary } from "./managed.ts";

export const usd = (n: number | undefined) => (n === undefined ? "unavailable" : `$${n.toFixed(2)}`);
export const pct = (n: number | undefined) => (n === undefined ? "unavailable" : `${(n * 100).toFixed(1)}%`);

/** The ratio with its coverage: a figure is PARTIAL whenever some managed thread had no session to take spend from. */
function ratioText(m: ManagedSummary): string {
	if (m.status === "not-configured") return "not configured";
	if (m.status === "unavailable") return "unavailable";
	if (!m.threads) return "no managed thread in the window";
	if (m.ratio === undefined) return `unavailable (coverage ${pct(m.coverage)} of ${m.threads} threads)`;
	const partial = m.coverage !== undefined && m.coverage < 1 ? `, PARTIAL, coverage ${pct(m.coverage)}` : "";
	return `${pct(m.ratio)}${partial} (${m.mapped} of ${m.threads} threads have sessions)`;
}

/** The short form for the Decisions view's line. */
export const managedLine = (m: ManagedSummary): string => `managed overhead ${ratioText(m)}`;

/** The numbers kept in state, from the report. */
export function summarizeManaged(r: OverheadReport): ManagedSummary {
	const m = r.managed;
	return {
		status: m.status,
		minCoverage: r.limits.managedRatio.minCoverage,
		...(m.report ? { threads: m.report.threads, mapped: m.report.mapped } : {}),
		...(m.coverage !== undefined ? { coverage: m.coverage } : {}),
		...(m.ratio !== undefined ? { ratio: m.ratio } : {}),
		...(m.costPerThread !== undefined ? { costPerThread: m.costPerThread } : {}),
	};
}

/** How the ratio is judged: only at full coverage with every fleet host reporting, and only when it is a trigger. `minCoverage` is the reporting bar. */
function judged(t: OverheadReport["limits"]["managedRatio"]): string {
	const bar = `judged only at full coverage with every fleet host reporting (reporting bar ${pct(t.minCoverage)})`;
	if (t.mode === "trigger") return `triggers above ${pct(t.threshold)}, ${bar}`;
	return `report only${t.threshold === undefined ? "" : `, target at most ${pct(t.threshold)}`}; ${bar}`;
}

/** The fleet total by host, what Chamberlain's launched butlers and investigators spent (by its launch records), and what was left out as experiments. */
export function fleetLines(r: OverheadReport): string[] {
	const out: string[] = [];
	if (r.fleet) {
		const hosts = Object.entries(r.fleet.byHost).map(([h, v]) => `${h} ${usd(v)}`);
		const excluded = r.fleet.excludedUsd > 0 ? `; EXCLUDED experiments ${usd(r.fleet.excludedUsd)} (in no figure)` : "";
		out.push(`    fleet ${usd(r.fleet.totalUsd)} (${hosts.join(", ")})${excluded}`);
	}
	if (r.launched) {
		const l = r.launched;
		out.push(
			`    launched by Chamberlain (its own records): butlers ${usd(l.butlersUsd)} (${l.butlers} threads), investigators ${usd(l.investigatorsUsd)} (${l.investigators})${l.unmapped ? `, ${l.unmapped} with no session` : ""}`,
		);
	}
	return out;
}

/** The lines of the table: the ratio, the thread count and cost per thread, and the coverage by host. */
export function managedLines(r: OverheadReport, W: string): string[] {
	const m = summarizeManaged(r);
	const out = [`  managed overhead     ${W} ${ratioText(m)}  (${judged(r.limits.managedRatio)})`];
	const rep = r.managed.report;
	if (!rep) return out;
	out.push(`  managed threads      ${W} ${rep.threads}, cost per managed thread ${usd(r.managed.costPerThread)}`);
	if (rep.byHost.length)
		out.push(`    mapped/managed by host: ${rep.byHost.map((h) => `${h.host} ${h.mapped}/${h.managed}`).join(", ")}`);
	return out;
}

/**
 * The overhead numbers, as pure functions of rows already read: what the Steward and Chamberlain spend against the work that got done, and
 * how many of the Steward's wakes did nothing. No clock, no network, no database here; `collect.ts` reads the inputs.
 *
 * "Work that got done" is MERGED PRs, for now (Nathan, 2026-11-18): the one outcome GitHub states for itself. Tying the cost to better
 * outcomes comes later.
 *
 * What each number is, over a window (a rolling 24 h unless the caller says otherwise):
 * - spend: the Steward's tokens, priced with the one table (prices.ts), plus Chamberlain's own classifier calls. This is the BASIS the
 *   trigger uses. It comes from Chamberlain's own database only, so a missing LifeOS DB or a GitHub outage cannot change it.
 * - cost per merged PR: spend / PRs merged in the same window. Undefined with no PR (never a division by zero) or when the count is unknown.
 * - no-op rate: wakes that made no tool call / wakes measured with tool counts. A wake from before tool counts was measured is not counted.
 * - cost per useful wake: Steward spend / wakes that made at least one tool call.
 */
import { isWake } from "../steward/steward-tokens.ts";
import type { WakeUsage } from "../store/store-records.ts";
import type { OverheadConfig } from "./config.ts";
import { type CacheWrite, type Price, tokensUsd } from "./prices.ts";

export type MergedPr = { repo: string; number: number; mergedAt: number; title: string };

/**
 * The PRs merged in [from, to) as `repo#number`, each once, sorted. Repos in `excludeRepos` are left out, and so is a bors rollup PR unless
 * `countRollups`: a rollup bundles PRs that GitHub marks merged on their own, so counting it too would count the same work twice.
 */
export function countedPrs(
	prs: readonly MergedPr[],
	span: { from: number; to: number },
	g: Pick<OverheadConfig["github"], "rollupTitle" | "countRollups" | "excludeRepos">,
): string[] {
	const rollup = new RegExp(g.rollupTitle, "i");
	const excluded = new Set(g.excludeRepos.map((r) => r.toLowerCase()));
	const seen = new Set<string>();
	for (const p of prs)
		if (
			p.mergedAt >= span.from &&
			p.mergedAt < span.to &&
			!excluded.has(p.repo.toLowerCase()) &&
			(g.countRollups || !rollup.test(p.title))
		)
			seen.add(`${p.repo}#${p.number}`);
	return [...seen].sort();
}

export const countMerged = (...a: Parameters<typeof countedPrs>): number => countedPrs(...a).length;

export type WindowMetrics = {
	from: number;
	to: number;
	/** Steward turns of any kind with a usage row in the window. 0 means nothing was measured (the collector was not running), which is not the same as a Steward that cost nothing. */
	turns: number;
	/** Steward turns started by a Chamberlain wake. */
	wakes: number;
	/** Of those, the ones read with tool counts. The no-op rate is over these. */
	measured: number;
	noop: number;
	useful: number;
	noopRate?: number;
	/** The Steward's tokens priced, USD. Undefined when the model has no price: the number is unavailable, never zero. */
	stewardUsd?: number;
	classifierUsd: number;
	/** stewardUsd + classifierUsd: what the cost trigger divides. */
	basisUsd?: number;
	/** Merged PRs in the window; undefined when GitHub could not be read in full. */
	prs?: number;
	costPerPr?: number;
	costPerUsefulWake?: number;
};

export type WindowInput = {
	usage: readonly WakeUsage[];
	from: number;
	to: number;
	/** The Steward's price from `overhead.prices`. Undefined: no price for its model, so the spend is unavailable. */
	price?: Price;
	cacheWrite: CacheWrite;
	classifierUsd: number;
	prs?: number;
	/** The experiments could not be told apart (experiments.ts), so the rows may contain some: no spend and no no-op rate is judged. */
	unverified?: boolean;
};

/** A number a limit may be judged on: present and finite. Anything else (undefined, NaN, Infinity) crosses nothing. */
export const usable = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

/**
 * The Steward's spend over the rows, or undefined when it cannot be known: no price for its model, no usage rows in the window (nothing was
 * measured, which is not a Steward that cost nothing: a $0 here would become a $0 baseline), or a sum that is not a finite number.
 */
function stewardSpend(
	rows: readonly WakeUsage[],
	price: Price | undefined,
	cacheWrite: CacheWrite,
): number | undefined {
	if (!price || !rows.length) return undefined;
	const sum = rows.reduce((s, r) => s + tokensUsd(r, price, cacheWrite), 0);
	return Number.isFinite(sum) ? sum : undefined;
}

/** Pure: one window's numbers. */
export function windowMetrics(i: WindowInput): WindowMetrics {
	const rows = i.usage.filter((r) => r.startedAt >= i.from && r.startedAt < i.to);
	const wakes = rows.filter((r) => isWake(r.kind));
	const measured = wakes.filter((r) => r.toolCalls !== undefined);
	const noop = measured.filter((r) => r.toolCalls === 0).length;
	const useful = measured.length - noop;
	const stewardUsd = i.unverified ? undefined : stewardSpend(rows, i.price, i.cacheWrite);
	const basisUsd = stewardUsd === undefined ? undefined : stewardUsd + i.classifierUsd;
	const m: WindowMetrics = {
		from: i.from,
		to: i.to,
		turns: rows.length,
		wakes: wakes.length,
		measured: measured.length,
		noop,
		useful,
		classifierUsd: i.classifierUsd,
	};
	if (measured.length && !i.unverified) m.noopRate = noop / measured.length;
	if (stewardUsd !== undefined) m.stewardUsd = stewardUsd;
	if (basisUsd !== undefined) m.basisUsd = basisUsd;
	if (i.prs !== undefined) m.prs = i.prs;
	if (usable(basisUsd) && i.prs) m.costPerPr = basisUsd / i.prs;
	if (usable(stewardUsd) && useful) m.costPerUsefulWake = stewardUsd / useful;
	return m;
}

export type Crossing = {
	metric: "costPerPr" | "noopRate" | "spendShare" | "managedRatio";
	/** What was measured: USD for the cost metric (per PR, or the whole window's spend when no PR merged), a share for the other two. */
	value: number;
	threshold: number;
	/** One line the investigator's brief and the report both carry. */
	detail: string;
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * The cost per PR above which the cost trigger crosses: the lower of the fixed amount and the multiple of the baseline's cost per PR, whichever
 * are configured and known. A baseline with no cost per PR, or one that is not above zero, is unavailable: a $0 baseline would put the limit at
 * $0 and let any PR cross, so it gives no limit at all.
 */
export function costLimit(t: OverheadConfig["triggers"]["costPerPr"], baseline: WindowMetrics): number | undefined {
	const fromBaseline =
		t.baselineMultiplier !== undefined && usable(baseline.costPerPr) && baseline.costPerPr > 0
			? t.baselineMultiplier * baseline.costPerPr
			: undefined;
	const limits = [t.fixedUsd, fromBaseline].filter(usable);
	return limits.length ? Math.min(...limits) : undefined;
}

type Inputs = {
	day: WindowMetrics;
	baseline: WindowMetrics;
	spendShare?: number;
	/**
	 * The managed overhead ratio, the share of managed threads whose spend was found, how many were not, and whether every configured fleet host
	 * reported (a missing host is a short denominator, as for the share).
	 */
	managed?: { ratio?: number; coverage?: number; unmapped?: number; hostsComplete?: boolean };
	cfg: OverheadConfig;
};

function noopCrossing({ day, cfg }: Inputs): Crossing[] {
	const t = cfg.triggers.noopRate;
	if (t.mode !== "trigger" || t.threshold === undefined) return [];
	if (!usable(day.noopRate) || day.measured < t.minWakes || day.noopRate <= t.threshold) return [];
	return [
		{
			metric: "noopRate",
			value: day.noopRate,
			threshold: t.threshold,
			detail: `no-op wake rate ${pct(day.noopRate)} (${day.noop} of ${day.measured} wakes made no tool call), above ${pct(t.threshold)}`,
		},
	];
}

function costCrossing({ day, baseline, cfg }: Inputs): Crossing[] {
	const t = cfg.triggers.costPerPr;
	if (t.mode !== "trigger" || !usable(day.basisUsd) || day.prs === undefined) return [];
	if (day.prs === 0)
		return t.zeroPrFloorUsd !== undefined && day.basisUsd > t.zeroPrFloorUsd
			? [
					{
						metric: "costPerPr",
						value: day.basisUsd,
						threshold: t.zeroPrFloorUsd,
						detail: `${usd(day.basisUsd)} of Steward and Chamberlain spend in the window with no PR merged, above the ${usd(t.zeroPrFloorUsd)} floor`,
					},
				]
			: [];
	const limit = costLimit(t, baseline);
	if (!usable(day.costPerPr) || !usable(limit) || day.costPerPr <= limit) return [];
	return [
		{
			metric: "costPerPr",
			value: day.costPerPr,
			threshold: limit,
			detail: `${usd(day.costPerPr)} per merged PR (${usd(day.basisUsd)} over ${day.prs} PRs), above ${usd(limit)}`,
		},
	];
}

function shareCrossing({ spendShare, cfg }: Inputs): Crossing[] {
	const t = cfg.triggers.spendShare;
	if (t.mode !== "trigger" || t.threshold === undefined || !usable(spendShare) || spendShare <= t.threshold) return [];
	return [
		{
			metric: "spendShare",
			value: spendShare,
			threshold: t.threshold,
			detail: `${pct(spendShare)} of the fleet's Claude spend, above ${pct(t.threshold)}`,
		},
	];
}

/**
 * The managed ratio crosses only when the operator made it a trigger AND every managed thread's spend was found (none unmapped) AND every
 * configured fleet host reported. A ratio over fewer is partial: its denominator is short, so it overstates, and it is only reported, never
 * judged, at ANY coverage short of full, `minCoverage` included (that is the bar the report flags, not a licence to trigger on a partial ratio).
 */
function managedCrossing({ managed, cfg }: Inputs): Crossing[] {
	const t = cfg.triggers.managedRatio;
	if (t.mode !== "trigger" || t.threshold === undefined || !managed) return [];
	const { ratio, coverage } = managed;
	if (managed.unmapped !== 0 || managed.hostsComplete !== true) return [];
	if (!usable(ratio) || !usable(coverage) || coverage < 1 || ratio <= t.threshold) return [];
	return [
		{
			metric: "managedRatio",
			value: ratio,
			threshold: t.threshold,
			detail: `Chamberlain-caused spend is ${pct(ratio)} of what the threads it manages spent (coverage ${pct(coverage)}), above ${pct(t.threshold)}`,
		},
	];
}

/**
 * Pure: the limits the window crosses, for the metrics whose mode is "trigger" (a "report" metric crosses nothing). Fails closed: a number that is
 * unavailable (no PR count, no price, no fleet total, too few wakes, no baseline, too little coverage) crosses nothing.
 */
export const crossings = (a: Inputs): Crossing[] => [
	...noopCrossing(a),
	...costCrossing(a),
	...shareCrossing(a),
	...managedCrossing(a),
];

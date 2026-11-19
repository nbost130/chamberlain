/**
 * Reads the inputs and builds the overhead report: the Steward's usage rows and Chamberlain's classifier spend from its own database, the
 * merged PRs from GitHub, and the fleet total and the managed threads' spend from the LifeOS database. The numbers themselves are metrics.ts and
 * managed.ts; this file only fetches.
 *
 * Every number says which of three things it is: measured, "not configured" (the operator has not asked for it: no owners or repos, fleet
 * source off), or "unavailable" (asked for, and the read failed). Each outside read fails alone: GitHub down means the PR numbers and the cost
 * trigger that needs them are unavailable; the LifeOS database down means the spend share and the managed ratio are. A gap is a line in
 * `unavailable` or `notConfigured`, shown wherever the report is shown, and never filled with a guess.
 */
import { SENDS_TEXT } from "../classifier/config.ts";
import type { GhRead } from "../decide/hold-lookup.ts";
import { errClass } from "../obs/fields.ts";
import type { Store } from "../store/store.ts";
import { causedUsdOf, type ManagedSection, readManaged } from "./collect-managed.ts";
import { DAY_MS, HOUR_MS, type OverheadConfig, perPrConfigured } from "./config.ts";
import { type FleetSpend, fleetSpend, type RunQuery } from "./fleet-spend.ts";
import { mergedPrs } from "./merged-prs.ts";
import {
	type Crossing,
	costLimit,
	countedPrs,
	crossings,
	type MergedPr,
	usable,
	type WindowMetrics,
	windowMetrics,
} from "./metrics.ts";
import { type Price, priceOf } from "./prices.ts";
import type { Status } from "./status.ts";

export type { Status } from "./status.ts";

export type OverheadReport = {
	at: number;
	/** The Steward's model, from `models.steward`; undefined when none is configured. */
	model?: string;
	cacheWrite: "5m" | "1h";
	windowMs: number;
	baselineMs: number;
	/** The rolling window; the baseline period before it; the trailing baseline-length period ending now; and `windowMs` windows ending 2, 1 and 0 windows ago (oldest first). */
	day: WindowMetrics;
	baseline: WindowMetrics;
	trailing: WindowMetrics;
	trend: WindowMetrics[];
	prStatus: Status;
	fleetStatus: Status;
	fleet?: FleetSpend;
	/**
	 * The HEADLINE overhead share: Chamberlain-caused spend (the Steward, Chamberlain's own model calls, the threads it launches and the
	 * investigator) / the fleet's spend, over the window, experiments (`excludeProjects`, `excludeLabels`) out of both. Named `spendShare` because
	 * that is the trigger key (`triggers.spendShare`) that judges it.
	 */
	spendShare?: number;
	/** The Steward's own spend / the same fleet spend, shown beside the headline. */
	stewardShare?: number;
	/**
	 * The MANAGED overhead ratio: Chamberlain-caused spend / the spend of the T3 threads Chamberlain supervised in the window, with the count, the cost
	 * per managed thread and the COVERAGE (how many managed threads had a LifeOS session to take spend from). Below full coverage the ratio is partial.
	 */
	managed: ManagedSection;
	crossings: Crossing[];
	/** What was asked for and could not be read, one line each. */
	unavailable: string[];
	/** What the operator has not configured, one line each. */
	notConfigured: string[];
	/** Each trigger as configured, with the limit it resolved to this time. */
	limits: {
		costPerPr: OverheadConfig["triggers"]["costPerPr"] & { limitUsd?: number };
		noopRate: OverheadConfig["triggers"]["noopRate"];
		spendShare: OverheadConfig["triggers"]["spendShare"];
		managedRatio: OverheadConfig["triggers"]["managedRatio"];
	};
	/** The merged PRs of the window, repo and number, for the investigator's brief and for a reader who wants to check the count. */
	prList: string[];
};

export type CollectDeps = {
	store: Pick<Store, "usage" | "dispositions" | "events" | "wakes">;
	cfg: OverheadConfig;
	/** The Steward's model from the central selection. */
	model?: string;
	/** The threads Chamberlain runs itself (pinned, butlers, investigators): never counted as managed. */
	own?: readonly string[];
	gh: GhRead;
	query?: RunQuery;
	now: number;
};

type Notes = Pick<OverheadReport, "unavailable" | "notConfigured">;

/** Chamberlain's own classifier spend in [from, to): the database sums from a start, so the window is the difference of two sums. */
function classifierUsd(store: CollectDeps["store"], from: number, to: number): number {
	const providers = [...SENDS_TEXT];
	return store.dispositions.usage(from, providers).usd - store.dispositions.usage(to, providers).usd;
}

/**
 * Why a read failed, as it may be shown: a fixed class, never the error's text. The text of a failed `gh` or LifeOS call is a tool's own stderr,
 * which can echo a header or a token, and this line goes into the report, the Decisions view, the state and the investigator's brief.
 */
const why = (e: unknown) => `unavailable (${errClass(e)})`;

async function readPrs(d: CollectDeps, since: number, r: Notes) {
	if (!perPrConfigured(d.cfg)) {
		r.notConfigured.push("merged PRs: set overhead.github.owners or overhead.github.repos to count them");
		return { status: "not-configured" as const };
	}
	try {
		return { status: "ok" as const, prs: await mergedPrs(d.gh, d.cfg.github, since) };
	} catch (e) {
		r.unavailable.push(`merged PRs: ${why(e)}`);
		return { status: "unavailable" as const };
	}
}

async function readFleet(d: CollectDeps, r: Notes) {
	const w = d.cfg.windowHours * HOUR_MS;
	if (d.cfg.fleet.source === "off") {
		r.notConfigured.push('fleet spend: overhead.fleet.source is "off", so there is no spend share');
		return { status: "not-configured" as const };
	}
	try {
		return { status: "ok" as const, fleet: await fleetSpend(d.cfg, d.now - w, d.now, d.query) };
	} catch (e) {
		r.unavailable.push(`fleet spend: ${why(e)}`);
		return { status: "unavailable" as const };
	}
}

/** The Steward's price, or the reason it has none. */
function stewardPrice(d: CollectDeps, unavailable: string[]) {
	if (!d.model) unavailable.push("Steward spend: no models.steward in config.json, so its tokens cannot be priced");
	else if (!priceOf(d.cfg.prices, d.model))
		unavailable.push(`Steward spend: no price for "${d.model}" in overhead.prices`);
	return d.model ? priceOf(d.cfg.prices, d.model) : undefined;
}

/**
 * The overhead share, (Steward + Chamberlain's own calls + spawned threads + the investigator) / the fleet's spend, and the Steward's own share of
 * the same fleet; each undefined when either side is unknown. Experiments are already out of the fleet and spawned figures (fleet-spend.ts). A
 * configured host with no rows makes the denominator short by what it spent, so both are unavailable then, never a partial figure.
 */
function sharesOf(fleet: FleetSpend | undefined, day: WindowMetrics): { overhead?: number; steward?: number } {
	if (!fleet || fleet.missingHosts.length || !usable(fleet.totalUsd) || fleet.totalUsd <= 0) return {};
	const ratio = (n: number | undefined) => {
		const r = n === undefined ? undefined : n / fleet.totalUsd;
		return usable(r) ? r : undefined;
	};
	const overhead = usable(day.basisUsd) ? ratio(day.basisUsd + fleet.spawnedUsd + fleet.investigatorUsd) : undefined;
	const steward = ratio(day.stewardUsd);
	return { ...(overhead !== undefined ? { overhead } : {}), ...(steward !== undefined ? { steward } : {}) };
}

/** Each trigger as configured, with the cost limit it resolved to against this baseline. */
function limitsOf(cfg: OverheadConfig, baseline: WindowMetrics): OverheadReport["limits"] {
	const t = cfg.triggers;
	const limitUsd = costLimit(t.costPerPr, baseline);
	return {
		costPerPr: { ...t.costPerPr, ...(limitUsd !== undefined ? { limitUsd } : {}) },
		noopRate: t.noopRate,
		spendShare: t.spendShare,
		managedRatio: t.managedRatio,
	};
}

/** The window function: the metrics of [from, to) over the usage rows, read once for the longest span any window needs. */
function windowsOf(d: CollectDeps, price: Price | undefined, prs: readonly MergedPr[] | undefined) {
	const W = d.cfg.windowHours * HOUR_MS;
	const usage = d.store.usage.list({ since: d.now - Math.max(3 * W, W + d.cfg.baselineDays * DAY_MS) });
	return (from: number, to: number) =>
		windowMetrics({
			usage,
			from,
			to,
			...(price ? { price } : {}),
			cacheWrite: d.cfg.cacheWrite,
			classifierUsd: classifierUsd(d.store, from, to),
			...(prs ? { prs: countedPrs(prs, { from, to }, d.cfg.github).length } : {}),
		});
}

/** The report for the rolling windows ending at `d.now`. */
export async function collect(d: CollectDeps): Promise<OverheadReport> {
	const notes: Notes = { unavailable: [], notConfigured: [] };
	const W = d.cfg.windowHours * HOUR_MS;
	const B = d.cfg.baselineDays * DAY_MS;
	const price = stewardPrice(d, notes.unavailable);
	const [pr, fl] = await Promise.all([readPrs(d, d.now - Math.max(3 * W, W + B), notes), readFleet(d, notes)]);
	const window = windowsOf(d, price, pr.prs);
	const day = window(d.now - W, d.now);
	const baseline = window(d.now - W - B, d.now - W);
	const { overhead: spendShare, steward: stewardShare } = sharesOf(fl.fleet, day);
	const managed = await readManaged(
		{ store: d.store, cfg: d.cfg, own: d.own ?? [], ...(d.query ? { query: d.query } : {}) },
		{ from: d.now - W, to: d.now },
		causedUsdOf(day, fl.fleet),
		notes,
	);
	if (fl.fleet?.missingHosts.length)
		notes.unavailable.push(
			`spend share: no fleet rows for ${fl.fleet.missingHosts.join(", ")} in the window, so the total is short`,
		);
	return {
		at: d.now,
		...(d.model ? { model: d.model } : {}),
		cacheWrite: d.cfg.cacheWrite,
		windowMs: W,
		baselineMs: B,
		day,
		baseline,
		trailing: window(d.now - B, d.now),
		trend: [2, 1, 0].map((n) => window(d.now - (n + 1) * W, d.now - n * W)),
		prStatus: pr.status,
		fleetStatus: fl.fleet?.missingHosts.length ? "unavailable" : fl.status,
		...(fl.fleet ? { fleet: fl.fleet } : {}),
		...(spendShare !== undefined ? { spendShare } : {}),
		...(stewardShare !== undefined ? { stewardShare } : {}),
		managed,
		crossings: crossings({
			day,
			baseline,
			...(spendShare !== undefined ? { spendShare } : {}),
			managed: { ...(managed.ratio !== undefined ? { ratio: managed.ratio } : {}), ...coverageOf(managed) },
			cfg: d.cfg,
		}),
		...notes,
		limits: limitsOf(d.cfg, baseline),
		prList: pr.prs ? countedPrs(pr.prs, { from: d.now - W, to: d.now }, d.cfg.github) : [],
	};
}

const coverageOf = (m: ManagedSection): { coverage?: number } =>
	m.report?.coverage === undefined ? {} : { coverage: m.report.coverage };

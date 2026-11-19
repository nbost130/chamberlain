/**
 * Reads the inputs and builds the overhead report: the Steward's usage rows and Chamberlain's classifier spend from its own database, the
 * merged PRs from GitHub, and the fleet total from the LifeOS database. The numbers themselves are metrics.ts; this file only fetches.
 *
 * Every number says which of three things it is: measured, "not configured" (the operator has not asked for it: no owners or repos, fleet
 * source off), or "unavailable" (asked for, and the read failed). Each outside read fails alone: GitHub down means the PR numbers and the cost
 * trigger that needs them are unavailable; the LifeOS database down means the spend share is. A gap is a line in `unavailable` or
 * `notConfigured`, shown wherever the report is shown, and never filled with a guess.
 */
import { SENDS_TEXT } from "../classifier/config.ts";
import type { GhRead } from "../decide/hold-lookup.ts";
import type { Store } from "../store/store.ts";
import { DAY_MS, HOUR_MS, type OverheadConfig, perPrConfigured } from "./config.ts";
import { type FleetSpend, fleetSpend, type RunQuery } from "./fleet-spend.ts";
import { mergedPrs } from "./merged-prs.ts";
import { type Crossing, costLimit, countedPrs, crossings, type WindowMetrics, windowMetrics } from "./metrics.ts";
import { priceOf } from "./prices.ts";

export type Status = "ok" | "not-configured" | "unavailable";

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
	/** (Steward + Chamberlain spend + spawned eval/butler threads + the investigator) / the fleet's spend, over the window. */
	spendShare?: number;
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
	};
	/** The merged PRs of the window, repo and number, for the investigator's brief and for a reader who wants to check the count. */
	prList: string[];
};

export type CollectDeps = {
	store: Pick<Store, "usage" | "dispositions">;
	cfg: OverheadConfig;
	/** The Steward's model from the central selection. */
	model?: string;
	gh: GhRead;
	query?: RunQuery;
	now: number;
};

/** Chamberlain's own classifier spend in [from, to): the database sums from a start, so the window is the difference of two sums. */
function classifierUsd(store: CollectDeps["store"], from: number, to: number): number {
	const providers = [...SENDS_TEXT];
	return store.dispositions.usage(from, providers).usd - store.dispositions.usage(to, providers).usd;
}

const why = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 160);

async function readPrs(d: CollectDeps, since: number, r: Pick<OverheadReport, "unavailable" | "notConfigured">) {
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

async function readFleet(d: CollectDeps, r: Pick<OverheadReport, "unavailable" | "notConfigured">) {
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

/** (Steward + Chamberlain spend + spawned threads + the investigator) / the fleet's spend; undefined when either side is unknown. */
function shareOf(fleet: FleetSpend | undefined, day: WindowMetrics): number | undefined {
	if (!fleet || day.basisUsd === undefined || fleet.totalUsd <= 0) return undefined;
	return (day.basisUsd + fleet.spawnedUsd + fleet.investigatorUsd) / fleet.totalUsd;
}

/** Each trigger as configured, with the cost limit it resolved to against this baseline. */
function limitsOf(cfg: OverheadConfig, baseline: WindowMetrics): OverheadReport["limits"] {
	const t = cfg.triggers;
	const limitUsd = costLimit(t.costPerPr, baseline);
	return {
		costPerPr: { ...t.costPerPr, ...(limitUsd !== undefined ? { limitUsd } : {}) },
		noopRate: t.noopRate,
		spendShare: t.spendShare,
	};
}

/** The report for the rolling windows ending at `d.now`. */
export async function collect(d: CollectDeps): Promise<OverheadReport> {
	const unavailable: string[] = [];
	const notConfigured: string[] = [];
	const W = d.cfg.windowHours * HOUR_MS;
	const B = d.cfg.baselineDays * DAY_MS;
	const price = stewardPrice(d, unavailable);
	const [pr, fl] = await Promise.all([
		readPrs(d, d.now - Math.max(3 * W, W + B), { unavailable, notConfigured }),
		readFleet(d, { unavailable, notConfigured }),
	]);
	const usage = d.store.usage.list({ since: d.now - Math.max(3 * W, W + B) });
	const window = (from: number, to: number) =>
		windowMetrics({
			usage,
			from,
			to,
			...(price ? { price } : {}),
			cacheWrite: d.cfg.cacheWrite,
			classifierUsd: classifierUsd(d.store, from, to),
			...(pr.prs ? { prs: countedPrs(pr.prs, { from, to }, d.cfg.github).length } : {}),
		});
	const day = window(d.now - W, d.now);
	const baseline = window(d.now - W - B, d.now - W);
	const spendShare = shareOf(fl.fleet, day);
	if (fl.fleet?.missingHosts.length)
		unavailable.push(`fleet spend is short: no rows for ${fl.fleet.missingHosts.join(", ")} in the window`);
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
		fleetStatus: fl.status,
		...(fl.fleet ? { fleet: fl.fleet } : {}),
		...(spendShare !== undefined ? { spendShare } : {}),
		crossings: crossings({ day, baseline, ...(spendShare !== undefined ? { spendShare } : {}), cfg: d.cfg }),
		unavailable,
		notConfigured,
		limits: limitsOf(d.cfg, baseline),
		prList: pr.prs ? countedPrs(pr.prs, { from: d.now - W, to: d.now }, d.cfg.github) : [],
	};
}

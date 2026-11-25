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
import type { WakeUsage } from "../store/store-records.ts";
import { type LaunchedSpend, type ManagedSection, readSupervision } from "./collect-managed.ts";
import { DAY_MS, HOUR_MS, type OverheadConfig, perPrConfigured } from "./config.ts";
import {
	type ClassifierSpend,
	type Experiments,
	exclusionConfigured,
	readExperiments,
	usageTelemetrySession,
} from "./experiments.ts";
import { type FleetSpend, fleetSpend, type RunQuery } from "./fleet-spend.ts";
import type { OwnThreads } from "./managed.ts";
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
	/** What the butlers and investigators Chamberlain launched spent in the window, found by its own launch records. Undefined when it could not be read. */
	launched?: LaunchedSpend;
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
	own?: Partial<OwnThreads>;
	gh: GhRead;
	query?: RunQuery;
	now: number;
};

type Notes = Pick<OverheadReport, "unavailable" | "notConfigured">;

/** What Chamberlain recorded itself, with the experiments (experiments.ts) taken out of it. */
type Own = {
	usage: readonly WakeUsage[];
	spend: readonly ClassifierSpend[];
	experiments: Experiments;
	/** The experiments could not be told apart: the money figures and the no-op rate are not judged. */
	unverified: boolean;
};

/** Chamberlain's own classifier spend in [from, to), less the calls made for experiments: the database sums from a start, so the window is the difference of two sums. */
function classifierUsd(store: CollectDeps["store"], own: Own, from: number, to: number): number {
	const providers = [...SENDS_TEXT];
	const total = store.dispositions.usage(from, providers).usd - store.dispositions.usage(to, providers).usd;
	const left = own.spend.filter((r) => r.at >= from && r.at < to && own.experiments.threads.has(r.threadId));
	return total - left.reduce((s, r) => s + r.usd, 0);
}

/** The usage rows and classifier spend of the longest span any window needs, less the experiments. */
async function readOwn(d: CollectDeps, notes: Notes): Promise<Own> {
	const W = d.cfg.windowHours * HOUR_MS;
	const since = d.now - Math.max(3 * W, W + d.cfg.baselineDays * DAY_MS);
	const usage = d.store.usage.list({ since });
	const spend = exclusionConfigured(d.cfg) ? d.store.dispositions.spend(since, [...SENDS_TEXT]) : [];
	const { experiments, unverified } = await readExperiments(d, { usage, classifier: spend }, notes.unavailable);
	return {
		usage: usage.filter((r) => !experiments.sessions.has(usageTelemetrySession(r) ?? "")),
		spend,
		experiments,
		unverified,
	};
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

/**
 * The overhead share, Chamberlain-caused spend (the Steward, its own calls, the butlers and investigators it launched) / the fleet's spend, and the
 * Steward's own share of the same fleet; each undefined when either side is unknown. Experiments are out of the fleet and of the launched threads'
 * spend. A configured host with no rows makes the denominator short by what it spent, so both are unavailable then, never a partial figure.
 */
function sharesOf(
	fleet: FleetSpend | undefined,
	day: WindowMetrics,
	causedUsd: number | undefined,
): { overhead?: number; steward?: number } {
	if (!fleet || fleet.missingHosts.length || !usable(fleet.totalUsd) || fleet.totalUsd <= 0) return {};
	const ratio = (n: number | undefined) => {
		const r = n === undefined ? undefined : n / fleet.totalUsd;
		return usable(r) ? r : undefined;
	};
	const overhead = ratio(causedUsd);
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
function windowsOf(d: CollectDeps, own: Own, prs: readonly MergedPr[] | undefined) {
	return (from: number, to: number) =>
		windowMetrics({
			usage: own.usage,
			from,
			to,
			prices: d.cfg.prices,
			cacheWrite: d.cfg.cacheWrite,
			classifierUsd: classifierUsd(d.store, own, from, to),
			...(prs ? { prs: countedPrs(prs, { from, to }, d.cfg.github).length } : {}),
			...(own.unverified ? { unverified: true } : {}),
		});
}

/** The report for the rolling windows ending at `d.now`. */
export async function collect(d: CollectDeps): Promise<OverheadReport> {
	const notes: Notes = { unavailable: [], notConfigured: [] };
	const W = d.cfg.windowHours * HOUR_MS;
	const B = d.cfg.baselineDays * DAY_MS;
	const [pr, fl] = await Promise.all([readPrs(d, d.now - Math.max(3 * W, W + B), notes), readFleet(d, notes)]);
	const measurements = await readOwn(d, notes);
	const window = windowsOf(d, measurements, pr.prs);
	const day = window(d.now - W, d.now);
	const baseline = window(d.now - W - B, d.now - W);
	const { launched, managed, spendShare, stewardShare } = await fleetMetrics(d, {
		measurements,
		day,
		fleet: fl.fleet,
		notes,
	});
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
		...(launched ? { launched } : {}),
		managed,
		crossings: crossings({
			day,
			baseline,
			...(spendShare !== undefined ? { spendShare } : {}),
			managed: {
				...(managed.ratio !== undefined ? { ratio: managed.ratio } : {}),
				...coverageOf(managed),
				// A configured host with no fleet rows is a short denominator for this ratio as for the share; a fleet that could not be read cannot say.
				hostsComplete: fl.fleet !== undefined && fl.fleet.missingHosts.length === 0,
			},
			cfg: d.cfg,
		}),
		...notes,
		limits: limitsOf(d.cfg, baseline),
		prList: pr.prs ? countedPrs(pr.prs, { from: d.now - W, to: d.now }, d.cfg.github) : [],
	};
}

async function fleetMetrics(
	d: CollectDeps,
	{
		measurements,
		day,
		fleet,
		notes,
	}: {
		measurements: Own;
		day: WindowMetrics;
		fleet: FleetSpend | undefined;
		notes: Notes;
	},
) {
	if (day.stewardUsd === undefined)
		notes.unavailable.push(
			day.turns
				? "Steward spend: missing turn usage, recorded model or price in overhead.prices"
				: "Steward spend: no recorded turns in the window",
		);
	const own = { pinned: [], butlers: [], investigators: [], ...d.own };
	const source = { store: d.store, cfg: d.cfg, own, ...(d.query ? { query: d.query } : {}) };
	const fleetDay = coverageForFleet(d, measurements, day, notes);
	const { launched, causedUsd, managed } = await readSupervision(
		source,
		{ from: day.from, to: day.to },
		fleetDay,
		notes,
	);
	const { overhead: spendShare, steward: stewardShare } = sharesOf(fleet, fleetDay, causedUsd);
	if (fleet?.missingHosts.length)
		notes.unavailable.push(
			`spend share and managed ratio: no fleet rows for ${fleet.missingHosts.join(", ")} in the window, so the total is short and neither is judged`,
		);
	return { launched, managed, spendShare, stewardShare };
}

function coverageForFleet(d: CollectDeps, m: Own, day: WindowMetrics, notes: Notes): WindowMetrics {
	if (d.cfg.fleet.source === "off") return day;
	const covered = m.usage.every(
		(r) => r.startedAt < day.from || r.startedAt >= day.to || usageTelemetrySession(r) !== undefined,
	);
	if (covered) return day;
	notes.unavailable.push("spend share and managed ratio: fleet telemetry does not cover every metered turn");
	return { ...day, stewardUsd: undefined, basisUsd: undefined };
}

const coverageOf = (m: ManagedSection): { coverage?: number; unmapped?: number } => ({
	...(m.coverage !== undefined ? { coverage: m.coverage } : {}),
	...(m.unmapped !== undefined ? { unmapped: m.unmapped } : {}),
});

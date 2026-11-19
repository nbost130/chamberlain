/**
 * The `overhead` section of config.json: everything the overhead monitor measures, prices and decides, in one place. Every key is optional,
 * and the defaults are neutral: nothing about a person, a repository, a model or a price is built in. With nothing configured the monitor
 * measures what it can from Chamberlain's own database (the Steward's no-op wake rate), reports the rest as "not configured", and triggers nothing.
 *
 *   enabled              false   the daemon measures once per `checkEveryHours` and may open an investigator. `chamberlain overhead` works either way.
 *   windowHours          24      the rolling window every number covers
 *   baselineDays         7       the period before the window that a cost-per-PR limit given as a multiplier is measured against
 *   checkEveryHours      24      how often the daemon measures
 *   github               which merged PRs count as work done: owners and/or repos, repos to exclude, whether a rollup PR counts
 *   prices               USD per million tokens, per model: the rates the Steward's tokens are priced at (none shipped)
 *   cacheWrite           "1h"    which cache-write rate the usage rows are priced at ("5m" or "1h")
 *   fleet                where the whole fleet's spend comes from: "off" or "lifeos" (a read-only LifeOS query), for the spend share
 *   triggers             per metric (costPerPr, noopRate, spendShare): `mode` "report" (shown only, the default) or "trigger", and its limits
 *   investigator         the thread opened on a crossing: its provider, model and effort, project, cooldown and how many may be open
 *
 * Validation fails closed and early (`chamberlain config show`, every daemon start): a negative or non-numeric limit, an unknown key, a trigger
 * with no limit, or an enabled monitor with PR counting on and no price for the Steward's model is refused with a message naming the key.
 *
 * The Steward's model comes from `models.steward`, the central selection (ISA.md, ISC-2): it is looked up in `prices`, never named here.
 */
import { bool, num, object, oneOf, str } from "../config/config-fields.ts";
import { type ThreadModel, threadModel } from "../llm/selection.ts";
import { type CacheWrite, type PriceTable, parsePrices, priceOf } from "./prices.ts";

type Mode = "trigger" | "report";

export type OverheadConfig = {
	enabled: boolean;
	windowHours: number;
	baselineDays: number;
	checkEveryHours: number;
	github: {
		owners: string[];
		repos: string[];
		excludeRepos: string[];
		/** True: a bors rollup PR is counted like any other. Default false: it bundles PRs that GitHub marks merged on their own. */
		countRollups: boolean;
		/** A PR whose title matches this (case-insensitive) is a rollup. */
		rollupTitle: string;
	};
	prices: PriceTable;
	cacheWrite: CacheWrite;
	fleet: {
		source: "off" | "lifeos";
		/** The query command for source "lifeos", read-only. */
		command: string;
		/** Hosts the fleet total should cover; one with no rows in the window is named in the report. */
		hosts: string[];
		/** Session projects whose spend is reported as Chamberlain-spawned eval and butler threads. */
		spawnedProjects: string[];
	};
	triggers: {
		/** Spend per merged PR. Crosses above `fixedUsd`, or above `baselineMultiplier` x the baseline period's cost per PR (the lower of those given). `zeroPrFloorUsd`: with no PR merged, spend above this crosses. */
		costPerPr: { mode: Mode; baselineMultiplier?: number; fixedUsd?: number; zeroPrFloorUsd?: number };
		/** The share of the Steward's wakes that made no tool call. Not judged on fewer than `minWakes` measured wakes. */
		noopRate: { mode: Mode; threshold?: number; minWakes: number };
		/** The monitor's spend as a share of the fleet's. */
		spendShare: { mode: Mode; threshold?: number };
	};
	investigator: {
		enabled: boolean;
		/** The provider, model and effort of the thread: the same selection every launch uses, checked against the server's catalog before it starts. Null: none, so nothing can launch. */
		model: ThreadModel | null;
		/** The T3 project the thread is created in. */
		projectId: string | null;
		/** The thread's title starts with this; its spend is found by it and shown as its own line. */
		title: string;
		/** One investigation per this long, whatever the numbers do. */
		cooldownHours: number;
		/** Investigations that may be open at once. */
		maxOpen: number;
		/** An investigation still open after this long is closed by the clock, so a lost thread cannot block the next forever. */
		ttlHours: number;
		/** The operator's own rules for the investigator (workspace conventions, who to report to), appended to its brief. Empty: none. */
		instructions: string;
	};
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const OVERHEAD_DEFAULTS: OverheadConfig = {
	enabled: false,
	windowHours: 24,
	baselineDays: 7,
	checkEveryHours: 24,
	github: {
		owners: [],
		repos: [],
		excludeRepos: [],
		countRollups: false,
		rollupTitle: "^Rollup of \\d+ pull requests?",
	},
	prices: {},
	cacheWrite: "1h",
	fleet: { source: "off", command: "lifeos-axi", hosts: [], spawnedProjects: [] },
	triggers: {
		costPerPr: { mode: "report" },
		noopRate: { mode: "report", minWakes: 20 },
		spendShare: { mode: "report" },
	},
	investigator: {
		enabled: false,
		model: null,
		projectId: null,
		title: "Overhead investigation",
		cooldownHours: 24,
		maxOpen: 1,
		ttlHours: 72,
		instructions: "",
	},
};

type Obj = Record<string, unknown>;

/** The keys of a T3 thread selection, as `models.<role>` takes them. */
const MODEL_KEYS = ["adapter", "server", "instanceId", "model", "options"];

/** A name that goes into a GitHub search or a database query: letters, digits and a few separators, so nothing in it can change the statement. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

function names(o: Obj, k: string, where: string, ok: RegExp = SAFE): string[] {
	const v = o[k];
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ok.test(x)))
		throw Error(
			`${where}: ${k} must be a list of ${ok === SAFE_REPO ? "owner/name repositories" : "plain names (letters, digits, space . _ -)"}`,
		);
	return v as string[];
}

const plain = (o: Obj, k: string, where: string, d: string): string => {
	const v = str(o, k, where, d);
	if (!SAFE.test(v)) throw Error(`${where}: ${k} must be a plain name (letters, digits, space . _ -)`);
	return v;
};

const hours = (o: Obj, k: string, where: string, d: number) => num(o, k, where, { d, whole: false });

const optNum = (o: Obj, k: string, where: string, zeroOk: boolean): number | undefined =>
	o[k] === undefined ? undefined : num(o, k, where, { d: 0, whole: false, zeroOk });

const opt = <K extends string>(k: K, v: number | undefined): Partial<Record<K, number>> =>
	v === undefined ? {} : ({ [k]: v } as Record<K, number>);

const modeOf = (o: Obj, where: string): Mode =>
	oneOf(o, "mode", where, { allowed: ["trigger", "report"], d: "report" });

/** A share from 0 (exclusive) to 1: a limit of 0 would cross on everything, so it is refused. */
function share(o: Obj, where: string): number | undefined {
	const v = o.threshold;
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1)
		throw Error(`${where}: threshold must be a number above 0 and up to 1 (0.1 is 10%)`);
	return v;
}

function parseGithub(raw: unknown, where: string): OverheadConfig["github"] {
	const d = OVERHEAD_DEFAULTS.github;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, where, ["owners", "repos", "excludeRepos", "countRollups", "rollupTitle"]);
	const rollupTitle = str(o, "rollupTitle", where, d.rollupTitle);
	try {
		new RegExp(rollupTitle, "i");
	} catch {
		throw Error(`${where}: rollupTitle is not a valid regular expression`);
	}
	return {
		owners: names(o, "owners", where),
		repos: names(o, "repos", where, SAFE_REPO),
		excludeRepos: names(o, "excludeRepos", where, SAFE_REPO),
		countRollups: bool(o, "countRollups", where, d.countRollups),
		rollupTitle,
	};
}

function parseFleet(raw: unknown, where: string): OverheadConfig["fleet"] {
	const d = OVERHEAD_DEFAULTS.fleet;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, where, ["source", "command", "hosts", "spawnedProjects"]);
	return {
		source: oneOf(o, "source", where, { allowed: ["off", "lifeos"], d: d.source }),
		command: plain(o, "command", where, d.command),
		hosts: names(o, "hosts", where),
		spawnedProjects: names(o, "spawnedProjects", where),
	};
}

/** One metric's sub-section of `triggers`: its object (empty when left out) and its name in messages. */
const sub = (t: Obj, k: string, where: string, keys: string[]) => {
	const w = `${where}.${k}`;
	return { w, o: t[k] === undefined ? {} : object(t[k], w, ["mode", ...keys]) };
};

function parseTriggers(raw: unknown, where: string): OverheadConfig["triggers"] {
	const d = OVERHEAD_DEFAULTS.triggers;
	if (raw === undefined) return structuredClone(d);
	const t = object(raw, where, ["costPerPr", "noopRate", "spendShare"]);
	const c = sub(t, "costPerPr", where, ["baselineMultiplier", "fixedUsd", "zeroPrFloorUsd"]);
	const n = sub(t, "noopRate", where, ["threshold", "minWakes"]);
	const s = sub(t, "spendShare", where, ["threshold"]);
	return {
		costPerPr: {
			mode: modeOf(c.o, c.w),
			...opt("baselineMultiplier", optNum(c.o, "baselineMultiplier", c.w, false)),
			...opt("fixedUsd", optNum(c.o, "fixedUsd", c.w, true)),
			...opt("zeroPrFloorUsd", optNum(c.o, "zeroPrFloorUsd", c.w, true)),
		},
		noopRate: {
			mode: modeOf(n.o, n.w),
			...opt("threshold", share(n.o, n.w)),
			minWakes: num(n.o, "minWakes", n.w, { d: d.noopRate.minWakes, whole: true }),
		},
		spendShare: { mode: modeOf(s.o, s.w), ...opt("threshold", share(s.o, s.w)) },
	};
}

function parseInvestigator(raw: unknown, where: string): OverheadConfig["investigator"] {
	const d = OVERHEAD_DEFAULTS.investigator;
	if (raw === undefined) return structuredClone(d);
	const keys = ["enabled", "model", "projectId", "title", "cooldownHours", "maxOpen", "ttlHours", "instructions"];
	const o = object(raw, where, keys);
	const model =
		o.model === undefined || o.model === null
			? null
			: threadModel(object(o.model, `${where}.model`, MODEL_KEYS), `${where}.model`);
	return {
		enabled: bool(o, "enabled", where, d.enabled),
		model,
		projectId: o.projectId === undefined || o.projectId === null ? null : plain(o, "projectId", where, ""),
		title: plain(o, "title", where, d.title),
		cooldownHours: num(o, "cooldownHours", where, { d: d.cooldownHours, whole: false, zeroOk: true }),
		maxOpen: num(o, "maxOpen", where, { d: d.maxOpen, whole: true }),
		ttlHours: hours(o, "ttlHours", where, d.ttlHours),
		instructions: o.instructions === undefined ? d.instructions : str(o, "instructions", where, ""),
	};
}

/** Whether the per-PR metric has anything to count: an owner or a repo named. */
export const perPrConfigured = (c: OverheadConfig): boolean => c.github.owners.length + c.github.repos.length > 0;

/** The trigger rules that cannot be seen in one key: a trigger needs a limit, an investigator needs a model and a project, an enabled monitor needs prices. */
function triggerChecks(c: OverheadConfig, where: string): void {
	const t = c.triggers;
	const cp = t.costPerPr;
	const has = cp.baselineMultiplier ?? cp.fixedUsd ?? cp.zeroPrFloorUsd;
	if (cp.mode === "trigger" && has === undefined)
		throw Error(`${where}.triggers.costPerPr: mode "trigger" needs baselineMultiplier, fixedUsd or zeroPrFloorUsd`);
	if (cp.mode === "trigger" && !perPrConfigured(c))
		throw Error(
			`${where}.triggers.costPerPr: mode "trigger" needs github.owners or github.repos, so merged PRs can be counted`,
		);
	if (t.noopRate.mode === "trigger" && t.noopRate.threshold === undefined)
		throw Error(`${where}.triggers.noopRate: mode "trigger" needs a threshold`);
	if (t.spendShare.mode === "trigger" && t.spendShare.threshold === undefined)
		throw Error(`${where}.triggers.spendShare: mode "trigger" needs a threshold`);
	if (t.spendShare.mode === "trigger" && c.fleet.source === "off")
		throw Error(`${where}.triggers.spendShare: mode "trigger" needs fleet.source "lifeos", the share's denominator`);
}

function enabledChecks(c: OverheadConfig, where: string, stewardModel: string | undefined): void {
	if (c.investigator.enabled && (!c.investigator.model || !c.investigator.projectId))
		throw Error(`${where}.investigator: enabled needs model and projectId`);
	if (!c.enabled) return;
	const priced = Object.keys(c.prices).length;
	if (perPrConfigured(c) && !priced)
		throw Error(
			`${where}.prices: enabled with merged-PR counting needs a price table (USD per million tokens, per model)`,
		);
	if (priced && stewardModel && !priceOf(c.prices, stewardModel))
		throw Error(
			`${where}.prices: no price for the Steward's model "${stewardModel}" (models.steward); add it, or the Steward's spend cannot be priced`,
		);
}

/**
 * Pure: the section as given (undefined or null: none) with the defaults filled in, or the first thing wrong with it. `stewardModel` is
 * `models.steward`'s model when the document has one; with it, an enabled monitor must be able to price the Steward.
 */
export function parseOverhead(raw: unknown, stewardModel?: string): OverheadConfig {
	if (raw === undefined || raw === null) return structuredClone(OVERHEAD_DEFAULTS);
	const where = "overhead";
	const o = object(raw, where, [
		"enabled",
		"windowHours",
		"baselineDays",
		"checkEveryHours",
		"github",
		"prices",
		"cacheWrite",
		"fleet",
		"triggers",
		"investigator",
	]);
	const d = OVERHEAD_DEFAULTS;
	const c: OverheadConfig = {
		enabled: bool(o, "enabled", where, d.enabled),
		windowHours: hours(o, "windowHours", where, d.windowHours),
		baselineDays: hours(o, "baselineDays", where, d.baselineDays),
		checkEveryHours: hours(o, "checkEveryHours", where, d.checkEveryHours),
		github: parseGithub(o.github, `${where}.github`),
		prices: parsePrices(o.prices, `${where}.prices`),
		cacheWrite: oneOf(o, "cacheWrite", where, { allowed: ["5m", "1h"], d: d.cacheWrite }),
		fleet: parseFleet(o.fleet, `${where}.fleet`),
		triggers: parseTriggers(o.triggers, `${where}.triggers`),
		investigator: parseInvestigator(o.investigator, `${where}.investigator`),
	};
	triggerChecks(c, where);
	enabledChecks(c, where, stewardModel);
	return c;
}

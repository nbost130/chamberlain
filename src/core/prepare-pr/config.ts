/**
 * `sweep.preparePr` in config.json: built-in prepare-pr monitor with its own housekeeping timer.
 * Off by default. When enabled, oneWay and other modes are independent (shadow→live for one-way only).
 */
import { homedir } from "node:os";
import type { ItemMode } from "../store/store.ts";
import { DEFAULT_NO_MISTAKES_STATE, DEFAULT_REPOS, type RepoTarget } from "./discover.ts";

export const PREPARE_PR = "prepare-pr";
export const PREPARE_PR_OTHER = "prepare-pr-other";

export type PreparePrConfig = {
	enabled: boolean;
	/** Minutes between scans (housekeeping asks each minute). Default 1. */
	intervalMinutes: number;
	stateDb: string;
	repos: readonly RepoTarget[];
	/** Mode for one-way-door urgent findings (`check:prepare-pr`). Default shadow. */
	oneWayMode: ItemMode;
	/** Mode for other gates + settled-mismatch (`check:prepare-pr-other`). Default shadow. */
	otherMode: ItemMode;
};

export const PREPARE_PR_DEFAULTS: PreparePrConfig = {
	enabled: false,
	intervalMinutes: 1,
	stateDb: DEFAULT_NO_MISTAKES_STATE,
	repos: DEFAULT_REPOS,
	oneWayMode: "shadow",
	otherMode: "shadow",
};

const KEYS = ["enabled", "intervalMinutes", "stateDb", "repos", "oneWayMode", "otherMode"];
const MODES = new Set(["silenced", "shadow", "live"]);

function parseRepos(raw: unknown): readonly RepoTarget[] {
	if (raw === undefined) return PREPARE_PR_DEFAULTS.repos;
	if (!Array.isArray(raw) || !raw.length) throw Error("sweep.preparePr: repos must be a non-empty array");
	return raw.map((r, i) => {
		if (!r || typeof r !== "object" || Array.isArray(r)) throw Error(`sweep.preparePr: repos[${i}] must be an object`);
		const o = r as Record<string, unknown>;
		if (typeof o.name !== "string" || !o.name.trim()) throw Error(`sweep.preparePr: repos[${i}].name required`);
		if (typeof o.path !== "string" || !o.path.trim()) throw Error(`sweep.preparePr: repos[${i}].path required`);
		return {
			name: o.name.trim(),
			path: o.path.trim().replace(/^~(?=\/)/, homedir()),
		};
	});
}

function parseMode(raw: unknown, key: string, fallback: ItemMode): ItemMode {
	if (raw === undefined) return fallback;
	if (typeof raw !== "string" || !MODES.has(raw))
		throw Error(`sweep.preparePr: ${key} must be silenced, shadow or live`);
	return raw as ItemMode;
}

function positiveMinutes(raw: unknown): number {
	if (raw === undefined) return PREPARE_PR_DEFAULTS.intervalMinutes;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
		throw Error("sweep.preparePr: intervalMinutes must be a positive number");
	return raw;
}

/** Pure: the `sweep.preparePr` section, with defaults. Unknown keys throw. */
export function parsePreparePr(raw: unknown): PreparePrConfig {
	if (raw === undefined) return { ...PREPARE_PR_DEFAULTS, repos: [...PREPARE_PR_DEFAULTS.repos] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("sweep.preparePr: expected an object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!KEYS.includes(k)) throw Error(`sweep.preparePr: unknown key "${k}" (known: ${KEYS.join(", ")})`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error("sweep.preparePr: enabled must be true or false");
	if (o.stateDb !== undefined && (typeof o.stateDb !== "string" || !o.stateDb.trim()))
		throw Error("sweep.preparePr: stateDb must be a non-empty string");
	return {
		enabled: o.enabled ?? PREPARE_PR_DEFAULTS.enabled,
		intervalMinutes: positiveMinutes(o.intervalMinutes),
		stateDb: ((o.stateDb as string | undefined) ?? PREPARE_PR_DEFAULTS.stateDb).replace(/^~(?=\/)/, homedir()),
		repos: parseRepos(o.repos),
		oneWayMode: parseMode(o.oneWayMode, "oneWayMode", PREPARE_PR_DEFAULTS.oneWayMode),
		otherMode: parseMode(o.otherMode, "otherMode", PREPARE_PR_DEFAULTS.otherMode),
	};
}

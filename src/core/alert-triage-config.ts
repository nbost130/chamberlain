/** The `alertTriage` section: rules for critical alerts, behind a flag that defaults off. */
import { cfg } from "./layout.ts";

export const ALERT_TRIAGE = "alert-triage";
export const TRIAGE_KIND_OB = "obligation";
export const TRIAGE_KIND_SEQ = "seq";
export const TRIAGE_WAKE_KIND = "alert_triage_critical";

const RIGHTS = ["secrets", "deploy", "delete-data", "outbound", "spend", "weaken-guard"] as const;
export type Right = (typeof RIGHTS)[number];
export type Outcome = "steward-task" | "human" | "pass-through";

export type TriageRule = {
	id: string;
	match: { source?: string; family?: string };
	outcome: Outcome;
	right?: Right;
};

export type TriageConfig = {
	enabled: boolean;
	rules: TriageRule[];
	ackMinutes: number;
	batchPerTick: number;
	maxInFlight: number;
	readBudgetBytes: number;
	/** Set when the file was invalid; rules are empty and the alarm should fire. */
	invalid?: boolean;
};

const TRIAGE_DEFAULTS: TriageConfig = {
	enabled: false,
	rules: [],
	ackMinutes: 15,
	batchPerTick: 5,
	maxInFlight: 10,
	readBudgetBytes: 8 * 1024 * 1024,
};

const ID_OK = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OUTCOMES = new Set<string>(["steward-task", "human", "pass-through"]);
const RIGHT_SET = new Set<string>(RIGHTS);
const TOP_KEYS = new Set(["enabled", "rules", "ackMinutes", "batchPerTick", "maxInFlight", "readBudgetBytes"]);
const RULE_KEYS = new Set(["id", "match", "outcome", "right"]);

function rightOk(outcome: Outcome, right: string | undefined): boolean {
	if (outcome === "human") return Boolean(right && RIGHT_SET.has(right));
	return right === undefined;
}

/** Sentinel that cannot collide with an accepted match string such as `"bad"` (R1). */
const INVALID = Symbol("invalid-match");
type Invalid = typeof INVALID;

/** Present match fields must be non-empty strings; a number/null becomes match-everything otherwise (B3). */
function matchField(v: unknown): string | undefined | Invalid {
	if (v === undefined) return undefined;
	if (typeof v === "string" && v) return v;
	return INVALID;
}

function parseMatch(raw: unknown): TriageRule["match"] | Invalid {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return INVALID;
	const m = raw as Record<string, unknown>;
	for (const k of Object.keys(m)) if (k !== "source" && k !== "family") return INVALID;
	const source = matchField(m.source);
	const family = matchField(m.family);
	if (source === INVALID || family === INVALID) return INVALID;
	return { ...(source ? { source } : {}), ...(family ? { family } : {}) };
}

function parseRule(raw: unknown, usedIds: Set<string>): TriageRule | Invalid {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return INVALID;
	const o = raw as Record<string, unknown>;
	if ([...Object.keys(o)].some((k) => !RULE_KEYS.has(k))) return INVALID;
	if (typeof o.id !== "string" || !ID_OK.test(o.id) || usedIds.has(o.id)) return INVALID;
	if (!OUTCOMES.has(String(o.outcome))) return INVALID;
	const match = parseMatch(o.match);
	if (match === INVALID) return INVALID;
	const outcome = o.outcome as Outcome;
	const right = o.right !== undefined ? String(o.right) : undefined;
	if (!rightOk(outcome, right)) return INVALID;
	usedIds.add(o.id);
	return { id: o.id, match, outcome, ...(right ? { right: right as Right } : {}) };
}

function invalid(o: Record<string, unknown>): TriageConfig {
	// Keep explicit enabled so the triage path still runs with empty rules + alarm (B3).
	return { ...TRIAGE_DEFAULTS, enabled: o.enabled === true, invalid: true };
}

/** Pure: the triage config from a parsed object. Invalid → empty rules + invalid flag. */
export function parseTriageConfig(raw: unknown): TriageConfig {
	if (raw === undefined || raw === null) return { ...TRIAGE_DEFAULTS };
	if (typeof raw !== "object" || Array.isArray(raw)) return { ...TRIAGE_DEFAULTS, invalid: true };
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!TOP_KEYS.has(k)) return invalid(o);
	if (o.rules !== undefined && !Array.isArray(o.rules)) return invalid(o);
	const usedIds = new Set<string>();
	const rules: TriageRule[] = [];
	for (const r of o.rules ?? []) {
		const p = parseRule(r, usedIds);
		if (p === INVALID) return invalid(o);
		rules.push(p);
	}
	const num = (k: string, d: number) =>
		typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= 1 ? Math.floor(o[k] as number) : d;
	return {
		enabled: o.enabled === true,
		rules,
		ackMinutes: num("ackMinutes", TRIAGE_DEFAULTS.ackMinutes),
		batchPerTick: num("batchPerTick", TRIAGE_DEFAULTS.batchPerTick),
		maxInFlight: num("maxInFlight", TRIAGE_DEFAULTS.maxInFlight),
		readBudgetBytes: num("readBudgetBytes", TRIAGE_DEFAULTS.readBudgetBytes),
	};
}

export function readTriageConfig(conf: string): TriageConfig {
	try {
		return parseTriageConfig(cfg(conf, "alertTriage"));
	} catch {
		return { ...TRIAGE_DEFAULTS };
	}
}

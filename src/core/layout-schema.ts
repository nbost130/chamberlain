/** The config document's schema: the files and directories, the scalar and section keys, and the checks a config.json must pass. */
import { SchemaTooNewError } from "./schema.ts";
import { parseSettledMatch } from "./settings-parse.ts";
import { configDir } from "./state-dir.ts";

export const CONFIG_FILE = "config.json";
export const SECRETS_DIR = "secrets";
/** config.json carries its own version, apart from the legacy files' (src/core/schema.ts): it began at 1 with this layout. */
export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CONF = configDir(process.env, process.env.HOME ?? "");

/** A config.json that cannot be used: not JSON, the wrong shape, or a mode that lets someone else change it. */
export class ConfigFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigFileError";
	}
}

// ---- the keys ------------------------------------------------------------------------------------------

export type ScalarKind = "string" | "posnum" | "nonneg" | "posint" | "boolean" | "list";
/** The scalar keys, each with the kind of value it takes. Each one has an environment override (`envName`). */
export const SCALARS = {
	principal: "string",
	t3Dir: "string",
	t3StateDb: "string",
	t3Origin: "string",
	alertCmd: "string",
	compactTokens: "posnum",
	recover: "boolean",
	exclude: "list",
	reportQuietMs: "nonneg",
	reportHoldMs: "nonneg",
	stallMs: "nonneg",
	cardUnverifiedAlarmMs: "nonneg",
	maxAttempts: "posint",
	gh: "string",
	healthFormatPattern: "string",
	stewardTokens: "boolean",
} as const satisfies Record<string, ScalarKind>;
export type ScalarKey = keyof typeof SCALARS;
export type ScalarValue<K extends ScalarKey> = (typeof SCALARS)[K] extends "boolean"
	? boolean
	: (typeof SCALARS)[K] extends "list"
		? string[]
		: (typeof SCALARS)[K] extends "string"
			? string
			: number;

/** The sections of config.json that are objects or lists, not scalars. */
export const SECTIONS = [
	"settledMatch",
	"threads",
	"servers",
	"web",
	"sweep",
	"alertDesk",
	"operatingRules",
	"judge",
] as const;
export const THREADS = ["steward", "decisions", "desk"] as const;
export type ThreadKey = (typeof THREADS)[number];
/** Bookkeeping the migration writes: when, and from which legacy files. Not a setting. */
const BOOKKEEPING = ["schemaVersion", "migrated"] as const;

/** The one naming rule: CHAMBERLAIN_ + the key in UPPER_SNAKE_CASE. */
export const envName = (key: string): string =>
	`CHAMBERLAIN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
/** Every environment variable that overrides a key, with its key. */
export const ENV_KEYS: Record<string, ScalarKey> = Object.fromEntries(
	(Object.keys(SCALARS) as ScalarKey[]).map((k) => [envName(k), k]),
);

/** The legacy file each thread id lived in. */
export const LEGACY_THREAD_FILES: Record<ThreadKey, string> = {
	steward: "steward-thread",
	decisions: "decisions-thread",
	desk: "desk-thread",
};

// ---- config.json -------------------------------------------------------------------------------------

export const isObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** For each kind of scalar: what a value must be (as the error says it) and whether it is. */
const SCALAR_RULES: Record<ScalarKind, { what: string; ok: (v: unknown) => boolean }> = {
	string: { what: "a non-empty string", ok: (v) => typeof v === "string" && !!v.trim() },
	boolean: { what: "true or false", ok: (v) => typeof v === "boolean" },
	list: {
		what: "a list of non-empty strings",
		ok: (v) => Array.isArray(v) && !v.some((x) => typeof x !== "string" || !x.trim()),
	},
	posnum: { what: "a positive number", ok: (v) => typeof v === "number" && Number.isFinite(v) && v > 0 },
	nonneg: { what: "a number, 0 or more", ok: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 },
	posint: { what: "a whole number, 1 or more", ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 },
};

function checkScalar(key: string, kind: ScalarKind, v: unknown): void {
	if (v === null) return;
	const rule = SCALAR_RULES[kind];
	if (!rule.ok(v)) throw new ConfigFileError(`config.json: "${key}" must be ${rule.what}`);
}

/** Pure: the document's own version, when it has one: a non-negative integer no newer than this build reads. */
function checkSchemaVersion(v: unknown): void {
	if (v === undefined) return;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
		throw new ConfigFileError(`config.json: schemaVersion must be a non-negative integer, got ${JSON.stringify(v)}`);
	if (v > CONFIG_SCHEMA_VERSION) throw new SchemaTooNewError(CONFIG_FILE, v, CONFIG_SCHEMA_VERSION);
}

/** Pure: a section of config.json is null (none), a list (servers) or an object, and a settledMatch parses. */
function checkSection(k: string, val: unknown): void {
	if (val === null) return;
	if (k === "servers" ? !Array.isArray(val) : !isObject(val))
		throw new ConfigFileError(`config.json: "${k}" must be ${k === "servers" ? "a list" : "an object"}`);
	if (k === "settledMatch") {
		try {
			parseSettledMatch(val, "config.json");
		} catch (e) {
			throw new ConfigFileError((e as Error).message);
		}
	}
}

/** Pure: one top-level key: a scalar of its kind, a section of its shape, bookkeeping, or refused as unknown. */
function checkKey(raw: Record<string, unknown>, k: string): void {
	if (Object.hasOwn(SCALARS, k)) checkScalar(k, SCALARS[k as ScalarKey], raw[k]);
	else if ((SECTIONS as readonly string[]).includes(k)) checkSection(k, raw[k]);
	else if (!(BOOKKEEPING as readonly string[]).includes(k))
		throw new ConfigFileError(
			`config.json: unknown key "${k}" (keys: ${[...Object.keys(SCALARS), ...SECTIONS].join(", ")})`,
		);
}

/** Pure: the thread ids of a `threads` object: a known member each, null or a non-empty string. */
function checkThreads(t: unknown): void {
	if (!isObject(t)) return;
	for (const [k, val] of Object.entries(t)) {
		if (!(THREADS as readonly string[]).includes(k))
			throw new ConfigFileError(`config.json: "threads" has an unknown key "${k}" (keys: ${THREADS.join(", ")})`);
		if (val !== null && (typeof val !== "string" || !val.trim()))
			throw new ConfigFileError(`config.json: "threads.${k}" must be a non-empty thread id`);
	}
}

/** Pure: a parsed config.json checked, or the first thing wrong with it. A key this build does not know is refused, never ignored. */
export function parseConfigDoc(raw: unknown): Record<string, unknown> {
	if (!isObject(raw)) throw new ConfigFileError("config.json: expected a JSON object");
	checkSchemaVersion(raw.schemaVersion);
	for (const k of Object.keys(raw)) checkKey(raw, k);
	checkThreads(raw.threads);
	return raw;
}

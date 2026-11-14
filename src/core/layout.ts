/**
 * The config directory's layout, in one place.
 *
 *   <conf>/config.json     every setting that is not a secret: thread ids, servers, the page, sweep checks, the Alert Desk, operating rules,
 *                          and the tunables that also have an environment override. Not secret: 0600 or 0644, owned by you, never
 *                          group- or world-writable (it names commands the daemon runs).
 *   <conf>/secrets/<name>  one file per secret, mode 0600, in a 0700 directory: tokens and the webhook URLs (a URL can start an agent turn).
 *   <conf>/decision-rights.md, brief.d/, sweep-prompt.md, alert-desk-prompt.md, operating-rules.md
 *                          prose the operator edits; they stay files.
 *   <conf>/daemon.env      systemd's EnvironmentFile; it stays where the unit file points.
 *
 * The first Chamberlain kept each setting in a file of its own in the config directory (settings.json, servers.json, web.json, sweep.json,
 * alert-desk.json, operating-rules.json, judge.json, one file per thread id, the tokens and webhook URLs). Those files are the LEGACY layout:
 * `chamberlain config migrate` (src/core/config-migrate.ts) and every daemon or page start MOVE them: each secret is renamed into `secrets/`, and
 * each other file is renamed `<name>.migrated` once config.json is safely on disk. config.json lists what it moved (`migrated.files`).
 *
 * A file that was never migrated (an install the migration could not write to) is still READ for a key config.json does not hold, with one
 * `config-deprecated` line in the events log (`attachDeprecationLog`). A file that WAS migrated is never read again by its old name: if an outside
 * tool writes `steward-thread` or a re-minted `mac-token` there after the move, Chamberlain ignores it and logs `config-legacy-reappeared`
 * (`chamberlain config show` flags it). Setting a key to null in config.json says "none" and stops the fallback for that key.
 *
 * An environment variable overrides a scalar key. ONE rule names it: `CHAMBERLAIN_` + the key in UPPER_SNAKE_CASE (`stallMs` is
 * CHAMBERLAIN_STALL_MS, `t3StateDb` is CHAMBERLAIN_T3_STATE_DB). The two directories themselves are env-only (CHAMBERLAIN_CONF, CHAMBERLAIN_STATE).
 *
 * This module imports nothing from config.ts (which imports it), so it takes the config directory as an argument and defaults it the same way.
 */
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { authorityProblem, isPrivateFile, modeText } from "./private.ts";
import { SchemaTooNewError, checkVersion } from "./schema.ts";
import { parseSettings, parseSettledMatch } from "./settings-parse.ts";
import { configDir } from "./state-dir.ts";

export const CONFIG_FILE = "config.json";
export const SECRETS_DIR = "secrets";
/** config.json carries its own version, apart from the legacy files' (src/core/schema.ts): it began at 1 with this layout. */
export const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_CONF = configDir(process.env, process.env.HOME ?? "");

/** A config.json that cannot be used: not JSON, the wrong shape, or a mode that lets someone else change it. */
export class ConfigFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigFileError";
	}
}

// ---- the keys ------------------------------------------------------------------------------------------

type ScalarKind = "string" | "posnum" | "nonneg" | "posint" | "boolean" | "list";
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
} as const satisfies Record<string, ScalarKind>;
export type ScalarKey = keyof typeof SCALARS;
type ScalarValue<K extends ScalarKey> = (typeof SCALARS)[K] extends "boolean"
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
export type SectionKey = (typeof SECTIONS)[number];
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

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function checkScalar(key: string, kind: ScalarKind, v: unknown): void {
	const bad = (what: string) => {
		throw new ConfigFileError(`config.json: "${key}" must be ${what}`);
	};
	if (v === null) return;
	if (kind === "string" && (typeof v !== "string" || !v.trim())) bad("a non-empty string");
	if (kind === "boolean" && typeof v !== "boolean") bad("true or false");
	if (kind === "list" && (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())))
		bad("a list of non-empty strings");
	if (kind === "posnum" && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) bad("a positive number");
	if (kind === "nonneg" && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) bad("a number, 0 or more");
	if (kind === "posint" && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) bad("a whole number, 1 or more");
}

/** Pure: a parsed config.json checked, or the first thing wrong with it. A key this build does not know is refused, never ignored. */
export function parseConfigDoc(raw: unknown): Record<string, unknown> {
	if (!isObject(raw)) throw new ConfigFileError("config.json: expected a JSON object");
	const v = raw.schemaVersion;
	if (v !== undefined) {
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
			throw new ConfigFileError(`config.json: schemaVersion must be a non-negative integer, got ${JSON.stringify(v)}`);
		if (v > CONFIG_SCHEMA_VERSION) throw new SchemaTooNewError(CONFIG_FILE, v, CONFIG_SCHEMA_VERSION);
	}
	for (const k of Object.keys(raw)) {
		if (Object.hasOwn(SCALARS, k)) checkScalar(k, SCALARS[k as ScalarKey], raw[k]);
		else if ((SECTIONS as readonly string[]).includes(k)) {
			const val = raw[k];
			if (val === null) continue;
			if (k === "servers" ? !Array.isArray(val) : !isObject(val))
				throw new ConfigFileError(`config.json: "${k}" must be ${k === "servers" ? "a list" : "an object"}`);
			if (k === "settledMatch") {
				try {
					parseSettledMatch(val, "config.json");
				} catch (e) {
					throw new ConfigFileError((e as Error).message);
				}
			}
		} else if (!(BOOKKEEPING as readonly string[]).includes(k))
			throw new ConfigFileError(
				`config.json: unknown key "${k}" (keys: ${[...Object.keys(SCALARS), ...SECTIONS].join(", ")})`,
			);
	}
	const t = raw.threads;
	if (isObject(t)) {
		for (const [k, val] of Object.entries(t)) {
			if (!(THREADS as readonly string[]).includes(k))
				throw new ConfigFileError(`config.json: "threads" has an unknown key "${k}" (keys: ${THREADS.join(", ")})`);
			if (val !== null && (typeof val !== "string" || !val.trim()))
				throw new ConfigFileError(`config.json: "threads.${k}" must be a non-empty thread id`);
		}
	}
	return raw;
}

/** The parsed config.json, or undefined when there is none. The file must be the operator's alone to write (not group- or world-writable). */
export function readConfigFile(conf = DEFAULT_CONF): Record<string, unknown> | undefined {
	const p = `${conf}/${CONFIG_FILE}`;
	let text: string;
	try {
		const bad = authorityProblem(lstatSync(p), "file");
		if (bad) throw new ConfigFileError(`${p}: ${bad}. It names commands the daemon runs: chmod 600 it first.`);
		text = readFileSync(p, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	try {
		return parseConfigDoc(JSON.parse(text));
	} catch (e) {
		if (e instanceof SyntaxError) throw new ConfigFileError(`${p} is not valid JSON: ${e.message}`);
		throw e;
	}
}

/** Flushes a directory's entries (a rename, a new file) to disk, so a power loss cannot keep a later step and lose an earlier one. Best effort where a filesystem refuses. */
export function syncDir(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// EMPTY_CATCH_OK: a filesystem that cannot sync a directory has nothing more to give; the rename itself still happened.
	}
}

/** Writes a file through a temporary file that is flushed to disk before the rename, then flushes the directory. Mode 0600. */
export function writeFileDurable(path: string, text: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	syncDir(dirname(path));
}

/** Writes config.json whole: through a flushed temporary file and a rename, mode 0600. The caller holds the config directory's lock. */
export function writeConfigFile(conf: string, doc: Record<string, unknown>): void {
	writeFileDurable(
		`${conf}/${CONFIG_FILE}`,
		`${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, ...doc }, null, 2)}\n`,
	);
}

// ---- the legacy files ----------------------------------------------------------------------------------

type Legacy = { value: unknown; file: string; trust?: string };

/** May an old file be read by its old name? Not once it was migrated: a rewritten one is noticed, and never read. */
function readable(conf: string, name: string, secret: boolean): boolean {
	const s = oldFileState(conf, name, secret);
	if (s === "reappeared") reappeared(conf, name);
	return s === "usable";
}

/** A legacy JSON file: undefined when absent; `private` demands mode exactly 0600 (it did, as a config file), `authority` leaves the check to the caller. */
function legacyJson(
	conf: string,
	name: string,
	how: "private" | "authority",
): { raw: unknown; trust?: string } | undefined {
	if (!readable(conf, name, false)) return undefined;
	const p = `${conf}/${name}`;
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(p);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	if (how === "private" && !isPrivateFile(st))
		throw Error(
			`${p} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)}): chmod 600 it first.`,
		);
	const trust = how === "authority" ? authorityProblem(lstatSync(p), "file") : undefined;
	return { raw: JSON.parse(readFileSync(p, "utf8")) as unknown, ...(trust ? { trust } : {}) };
}

const withoutVersion = (o: unknown): unknown => {
	if (!isObject(o)) return o;
	const { schemaVersion: _drop, ...rest } = o;
	return rest;
};

/** A legacy thread id file, or undefined. Mode exactly 0600, as it always was. */
function legacyThread(conf: string, member: ThreadKey): string | undefined {
	return readLegacyText(conf, LEGACY_THREAD_FILES[member]);
}
function readLegacyText(conf: string, name: string): string | undefined {
	if (!readable(conf, name, false)) return undefined;
	try {
		const p = `${conf}/${name}`;
		const st = statSync(p);
		if (!isPrivateFile(st))
			throw Error(`${name} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
		return readFileSync(p, "utf8").trim() || undefined;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}

/** The legacy settings.json as config keys, or undefined. */
function legacySettings(conf: string): Record<string, unknown> | undefined {
	const doc = legacyJson(conf, "settings.json", "private");
	if (!doc) return undefined;
	const s = parseSettings(doc.raw);
	return {
		...(s.principalName ? { principal: s.principalName } : {}),
		...(s.t3BaseDir ? { t3Dir: s.t3BaseDir } : {}),
		...(s.t3StateDb ? { t3StateDb: s.t3StateDb } : {}),
		...(s.alertCommand ? { alertCmd: s.alertCommand } : {}),
		...(s.compactTokens !== undefined ? { compactTokens: s.compactTokens } : {}),
		...(s.settledMatch ? { settledMatch: s.settledMatch } : {}),
	};
}

/** The keys settings.json supplied, which file each legacy section came from, and how it is loaded. */
const LEGACY_SECTION_FILES: Record<string, { file: string; how: "private" | "authority"; strip: boolean }> = {
	servers: { file: "servers.json", how: "private", strip: false },
	web: { file: "web.json", how: "private", strip: true },
	sweep: { file: "sweep.json", how: "private", strip: true },
	alertDesk: { file: "alert-desk.json", how: "authority", strip: false },
	operatingRules: { file: "operating-rules.json", how: "private", strip: true },
	judge: { file: "judge.json", how: "authority", strip: false },
};
const SETTINGS_KEYS = ["principal", "t3Dir", "t3StateDb", "alertCmd", "compactTokens", "settledMatch"];

/** The value a legacy file holds for a config key, or undefined. */
export function legacyValue(conf: string, key: string): Legacy | undefined {
	if (SETTINGS_KEYS.includes(key)) {
		const s = legacySettings(conf);
		return s && Object.hasOwn(s, key) ? { value: s[key], file: "settings.json" } : undefined;
	}
	const spec = LEGACY_SECTION_FILES[key];
	if (!spec) return undefined;
	const doc = legacyJson(conf, spec.file, spec.how);
	if (!doc) return undefined;
	const raw = doc.raw;
	if (spec.strip || key === "servers") checkVersion(spec.file, isObject(raw) ? raw.schemaVersion : undefined);
	if (key === "servers") {
		const list = isObject(raw) ? raw.servers : undefined;
		if (!Array.isArray(list)) throw Error('servers.json: need {"schemaVersion": 2, "servers": [{name, adapter, ...}]}');
		return { value: list, file: spec.file };
	}
	return { value: spec.strip ? withoutVersion(raw) : raw, file: spec.file, ...(doc.trust ? { trust: doc.trust } : {}) };
}

/** The names of legacy files that exist in the config directory: what a migration reads and a cleanup may remove. */
export function legacyFilesPresent(conf: string): string[] {
	const names = [
		"settings.json",
		"servers.json",
		"web.json",
		"sweep.json",
		"alert-desk.json",
		"operating-rules.json",
		"judge.json",
		...Object.values(LEGACY_THREAD_FILES),
	];
	return names.filter((n) => existsSync(`${conf}/${n}`));
}

// ---- what the migration moved ------------------------------------------------------------------------------

/** What a non-secret file is renamed to when it has been migrated. */
export const MIGRATED_SUFFIX = ".migrated";
/** A secret file of the old layout, by its name: a token (`*-token`) or a webhook URL (`*-url`, and the `.steward` / `.prev` copies a hand-off makes). */
export const SECRET_FILE = /(^|-)(token|url)(\.[A-Za-z]+)?$/;
/** The old non-secret files, and where each one's values live now. */
export const NON_SECRET_HOME: Record<string, string> = {
	"settings.json": 'config.json keys "principal", "t3Dir", "t3StateDb", "alertCmd", "compactTokens", "settledMatch"',
	"servers.json": 'config.json "servers"',
	"web.json": 'config.json "web"',
	"sweep.json": 'config.json "sweep"',
	"alert-desk.json": 'config.json "alertDesk"',
	"operating-rules.json": 'config.json "operatingRules"',
	"judge.json": 'config.json "judge"',
	"steward-thread": 'config.json "threads.steward" (read it with: chamberlain config get threads.steward)',
	"decisions-thread": 'config.json "threads.decisions" (read it with: chamberlain config get threads.decisions)',
	"desk-thread": 'config.json "threads.desk" (read it with: chamberlain config get threads.desk)',
};
/** Where a migrated old name lives now. */
export const homeOfOld = (name: string): string => NON_SECRET_HOME[name] ?? `${SECRETS_DIR}/${name}`;

/** The names config.json says the migration moved. A config.json that cannot be read lists none. */
export function migratedNames(conf: string): Set<string> {
	try {
		const m = readConfigFile(conf)?.migrated;
		return new Set(
			isObject(m) && Array.isArray(m.files)
				? (m.files as unknown[]).filter((x): x is string => typeof x === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

/**
 * The journal of a migration in progress: written before the first secret moves, and removed only after the last non-secret file has been set aside.
 * It names the secrets that run moves and the files it will rename, so a crash at any step can be finished, and so a file that is merely waiting for
 * its rename (`pending`) can be told from one that was written again afterwards (`reappeared`): the record in config.json says a file was migrated,
 * the journal says its rename is still to come, and a file the record lists that is not in the journal is a stranger.
 */
export const JOURNAL = ".config-migrating";
export function readJournal(conf: string): { secrets: string[]; renames: string[] } {
	try {
		const j = JSON.parse(readFileSync(`${conf}/${JOURNAL}`, "utf8")) as { secrets?: unknown; renames?: unknown };
		const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		return { secrets: names(j.secrets), renames: names(j.renames) };
	} catch {
		return { secrets: [], renames: [] }; // no journal, or one that cannot be read
	}
}

/**
 * What an old file's name holds now:
 *   absent      nothing is at the old name;
 *   usable      never migrated: it is still read, as a fallback, with a deprecation notice;
 *   pending     migrated and its rename to `<name>.migrated` is still to come (the journal says so: a crash between the two steps): not read, config.json has the value;
 *   reappeared  migrated, and something wrote the old name again afterwards: NEVER read.
 */
export type OldState = "absent" | "usable" | "pending" | "reappeared";
export function oldFileState(conf: string, name: string, secret: boolean): OldState {
	try {
		lstatSync(`${conf}/${name}`);
	} catch {
		return "absent";
	}
	if (secret)
		return existsSync(`${conf}/${SECRETS_DIR}/${name}`) || migratedNames(conf).has(name) ? "reappeared" : "usable";
	if (!migratedNames(conf).has(name)) return "usable";
	// Listed as migrated: it is waiting for its rename only if the journal says so. Whether a `.migrated` file exists is not the question (it may have been deleted).
	return readJournal(conf).renames.includes(name) ? "pending" : "reappeared";
}

/** The old names present at their old place that Chamberlain will never read, because the migration moved them. */
export function reappearedFiles(conf: string): string[] {
	const out = Object.keys(NON_SECRET_HOME).filter((n) => oldFileState(conf, n, false) === "reappeared");
	const marked = migratedNames(conf);
	try {
		for (const e of readdirSync(conf, { withFileTypes: true }))
			if (
				(e.isFile() || e.isSymbolicLink()) &&
				!Object.hasOwn(NON_SECRET_HOME, e.name) &&
				(SECRET_FILE.test(e.name) || marked.has(e.name)) && // a secret by its name, or by what the migration moved (a token file called credential.md)
				oldFileState(conf, e.name, true) === "reappeared"
			)
				out.push(e.name);
	} catch {
		// EMPTY_CATCH_OK: an unreadable config directory has nothing to list; startup reports the directory itself.
	}
	return out;
}

// ---- deprecation notices -------------------------------------------------------------------------------

type Sink = (event: string, data: Record<string, unknown>) => void;
let sink: Sink | undefined;
const pending: [string, Record<string, unknown>][] = [];
const noticed = new Set<string>();

/**
 * One line in the events log, once per process and file, when a legacy file was read in place of config.json or secrets/. Without a log
 * (a command-line tool) the notice waits until one is attached and is dropped if none ever is.
 */
export function deprecated(conf: string, file: string, key: string, replacement: string): void {
	const id = `${conf}\0${file}`;
	if (noticed.has(id)) return;
	noticed.add(id);
	const data = {
		file,
		key,
		use: replacement,
		fix: "chamberlain config migrate",
		note: "still read as a fallback; config.json and secrets/ win when they hold the same key",
	};
	if (sink) sink("config-deprecated", data);
	else pending.push(["config-deprecated", data]);
}
/** One `config-legacy-reappeared` line per process and file: an old name that was migrated has been written again and is never read. */
export function reappeared(conf: string, file: string): void {
	const id = `reappeared\0${conf}\0${file}`;
	if (noticed.has(id)) return;
	noticed.add(id);
	const data = {
		file,
		now: homeOfOld(file),
		note: "this old file is never read: the value lives where `now` says. Write new secrets into secrets/<name>; read a setting with `chamberlain config get <key>`",
	};
	if (sink) sink("config-legacy-reappeared", data);
	else pending.push(["config-legacy-reappeared", data]);
}
/** Sends every notice so far, and every later one, to `log` (the daemon's and the page's event log). */
export function attachDeprecationLog(log: Sink): void {
	sink = log;
	for (const [event, data] of pending.splice(0)) log(event, data);
}
/** For tests: forget what was noticed and detach the log. */
export function resetLayout(): void {
	sink = undefined;
	pending.length = 0;
	noticed.clear();
}

// ---- reading -------------------------------------------------------------------------------------------

/** The value of a config key: config.json first (null there means "none"), else the legacy file, else undefined. */
export function configValue(conf: string, key: string): Legacy | undefined {
	const doc = readConfigFile(conf);
	if (doc && Object.hasOwn(doc, key)) return doc[key] === null ? undefined : { value: doc[key], file: CONFIG_FILE };
	const old = legacyValue(conf, key);
	if (old) deprecated(conf, old.file, key, `config.json "${key}"`);
	if (!old && !doc) {
		// A migration may have written config.json between the two reads above: look once more before saying there is nothing.
		const again = readConfigFile(conf);
		if (again && Object.hasOwn(again, key) && again[key] !== null) return { value: again[key], file: CONFIG_FILE };
	}
	return old;
}
/** Just the value. */
export const cfg = (conf: string, key: string): unknown => configValue(conf, key)?.value;

/** A thread id: `threads.<member>` of config.json, else the legacy file of that name. */
export function thread(conf: string, member: ThreadKey): string | undefined {
	const doc = readConfigFile(conf);
	const t = doc?.threads;
	if (doc && Object.hasOwn(doc, "threads") && t === null) return undefined; // "threads": null says none, and stops the fallback
	if (isObject(t) && Object.hasOwn(t, member)) return typeof t[member] === "string" ? (t[member] as string) : undefined;
	const old = legacyThread(conf, member);
	if (old) deprecated(conf, LEGACY_THREAD_FILES[member], `threads.${member}`, `config.json "threads.${member}"`);
	if (!old && !doc) {
		const again = readConfigFile(conf)?.threads;
		if (isObject(again) && typeof again[member] === "string") return again[member] as string; // a migration finished between the two reads
	}
	return old;
}

/** The string, number, boolean (`1` or `0`) or list an environment variable holds for a scalar key, or undefined when it is unset or unusable. */
function fromEnv<K extends ScalarKey>(key: K, env: Record<string, string | undefined>): ScalarValue<K> | undefined {
	const raw = env[envName(key)];
	if (raw === undefined) return undefined;
	const kind: ScalarKind = SCALARS[key];
	if (kind === "string") return raw as ScalarValue<K>;
	if (kind === "boolean") return (raw === "1" ? true : raw === "0" ? false : undefined) as ScalarValue<K> | undefined; // as before: only "1" turns a switch on
	if (kind === "list")
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean) as ScalarValue<K>;
	const n = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(n)) return undefined;
	if (kind === "posnum" && n <= 0) return undefined;
	if (kind === "nonneg" && n < 0) return undefined;
	if (kind === "posint" && (!Number.isInteger(n) || n < 1)) return undefined;
	return n as ScalarValue<K>;
}

/** A scalar setting: its environment variable, then config.json, then the legacy settings.json, else undefined (the caller's default). */
export function setting<K extends ScalarKey>(
	key: K,
	conf = DEFAULT_CONF,
	env = process.env,
): ScalarValue<K> | undefined {
	const e = fromEnv(key, env);
	if (e !== undefined) return e;
	return cfg(conf, key) as ScalarValue<K> | undefined;
}

/** True when a legacy-only setting was reached because config.json lacks it: for `chamberlain config show`. */
export function settingSource(key: ScalarKey, conf = DEFAULT_CONF, env = process.env): string {
	if (fromEnv(key, env) !== undefined) return `env ${envName(key)}`;
	const v = configValue(conf, key);
	return v ? (v.file === CONFIG_FILE ? CONFIG_FILE : `legacy ${v.file}`) : "default";
}

// ---- secrets -------------------------------------------------------------------------------------------

/** Whether a name is a plain relative path inside secrets/: no `..`, not absolute. */
const insideSecrets = (name: string) => name !== "" && !name.startsWith("/") && !name.split("/").includes("..");

/**
 * The trimmed contents of a secret, or undefined when absent or empty: `<conf>/secrets/<name>`, else the legacy `<conf>/<name>` with a
 * deprecation notice. A file that is not a private regular file (mode exactly 0600) throws: a token or URL anyone can read is refused, not used.
 */
export function readSecret(conf: string, name: string): string | undefined {
	const tryRead = (p: string): string | undefined | null => {
		try {
			const st = statSync(p);
			if (!isPrivateFile(st))
				throw Error(`${name} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
			return readFileSync(p, "utf8").trim() || undefined;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	};
	if (!insideSecrets(name)) return undefined; // a name that climbs out of the directory (`..`, an absolute path) names no secret
	const v = tryRead(`${conf}/${SECRETS_DIR}/${name}`);
	if (v !== null) return v;
	if (!readable(conf, name, true)) {
		// Moved by the migration (the old name is never read), or moved while we looked: once more in secrets/, where it is now.
		const moved = tryRead(`${conf}/${SECRETS_DIR}/${name}`);
		return moved === null ? undefined : moved;
	}
	const old = tryRead(`${conf}/${name}`);
	if (old === null) return undefined;
	deprecated(conf, name, `secrets/${name}`, `${SECRETS_DIR}/${name}`);
	return old;
}

/** A secret's file, new place first: for a tool that hands a path to something else. undefined when neither exists. */
export function secretPath(conf: string, name: string): string | undefined {
	if (insideSecrets(name) && existsSync(`${conf}/${SECRETS_DIR}/${name}`)) return `${conf}/${SECRETS_DIR}/${name}`;
	return insideSecrets(name) && readable(conf, name, true) ? `${conf}/${name}` : undefined;
}

/** The prose files the operator edits, which stay files in the config directory. Any other name `readNamed` is given is a secret. */
const PROSE_FILES = ["decision-rights.md", "sweep-prompt.md", "alert-desk-prompt.md", "operating-rules.md"];

/**
 * The one reader behind `readPrivate(name)`: a thread id name (`steward-thread`) reads config.json's `threads`, one of the prose files
 * (`decision-rights.md`, `sweep-prompt.md`) stays a file in the config directory (mode 0600, as before), and anything else is a secret.
 */
export function readNamed(conf: string, name: string): string | undefined {
	const member = (Object.keys(LEGACY_THREAD_FILES) as ThreadKey[]).find((k) => LEGACY_THREAD_FILES[k] === name);
	if (member) return thread(conf, member);
	if (PROSE_FILES.includes(name)) return readLegacyText(conf, name);
	return readSecret(conf, name);
}

// ---- writing -------------------------------------------------------------------------------------------

/** Whether a path is a regular file with mode exactly 0600. */
export const isPrivateSecret = (p: string): boolean => {
	try {
		return isPrivateFile(statSync(p));
	} catch {
		return false;
	}
};

/** Makes `<conf>/secrets` if it is missing, mode 0700. */
export function ensureSecretsDir(conf: string): string {
	const dir = `${conf}/${SECRETS_DIR}`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

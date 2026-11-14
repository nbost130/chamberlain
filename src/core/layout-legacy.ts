/** The old config directory (a file per setting): reading its values, what a migration moved, and the notices about old files still in use. */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readConfigFile } from "./layout-read.ts";
import { isObject, LEGACY_THREAD_FILES, SECRETS_DIR, type ThreadKey } from "./layout-schema.ts";
import { authorityProblem, isPrivateFile, modeText, privateFile } from "./private.ts";
import { checkVersion } from "./schema.ts";
import { parseSettings } from "./settings-parse.ts";

export type Legacy = { value: unknown; file: string; trust?: string };

/** May an old file be read by its old name? Not once it was migrated: a rewritten one is noticed, and never read. */
export function readable(conf: string, name: string, secret: boolean): boolean {
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
export function legacyThread(conf: string, member: ThreadKey): string | undefined {
	return readLegacyText(conf, LEGACY_THREAD_FILES[member]);
}
export function readLegacyText(conf: string, name: string): string | undefined {
	return readable(conf, name, false) ? privateFile(conf, name) : undefined;
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

/** The value of one of the keys the legacy settings.json supplied, or undefined. */
function legacySettingsValue(conf: string, key: string): Legacy | undefined {
	const s = legacySettings(conf);
	return s && Object.hasOwn(s, key) ? { value: s[key], file: "settings.json" } : undefined;
}

/** The list a legacy servers.json holds, or the refusal that says what it should look like. */
function legacyServers(raw: unknown, file: string): Legacy {
	const list = isObject(raw) ? raw.servers : undefined;
	if (!Array.isArray(list)) throw Error('servers.json: need {"schemaVersion": 2, "servers": [{name, adapter, ...}]}');
	return { value: list, file };
}

/** The value a legacy file holds for a config key, or undefined. */
export function legacyValue(conf: string, key: string): Legacy | undefined {
	if (SETTINGS_KEYS.includes(key)) return legacySettingsValue(conf, key);
	const spec = LEGACY_SECTION_FILES[key];
	if (!spec) return undefined;
	const doc = legacyJson(conf, spec.file, spec.how);
	if (!doc) return undefined;
	const raw = doc.raw;
	if (spec.strip || key === "servers") checkVersion(spec.file, isObject(raw) ? raw.schemaVersion : undefined);
	if (key === "servers") return legacyServers(raw, spec.file);
	return { value: spec.strip ? withoutVersion(raw) : raw, file: spec.file, ...(doc.trust ? { trust: doc.trust } : {}) };
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
function migratedNames(conf: string): Set<string> {
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

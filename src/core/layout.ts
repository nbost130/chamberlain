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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { deprecated, type Legacy, legacyThread, legacyValue, readable, readLegacyText } from "./layout-legacy.ts";
import { readConfigFile } from "./layout-read.ts";
import {
	CONFIG_FILE,
	CONFIG_SCHEMA_VERSION,
	DEFAULT_CONF,
	envName,
	isObject,
	LEGACY_THREAD_FILES,
	SCALARS,
	type ScalarKey,
	type ScalarKind,
	type ScalarValue,
	SECRETS_DIR,
	type ThreadKey,
} from "./layout-schema.ts";
import { isPrivateFile, readPrivate } from "./private.ts";

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

/** The number an environment variable holds for a numeric key, or undefined when it is blank, not finite, or out of the kind's range. */
export function envNumber(raw: string, kind: "posnum" | "nonneg" | "posint"): number | undefined {
	const n = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(n)) return undefined;
	if (kind === "posnum" && n <= 0) return undefined;
	if (kind === "nonneg" && n < 0) return undefined;
	if (kind === "posint" && (!Number.isInteger(n) || n < 1)) return undefined;
	return n;
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
	return envNumber(raw, kind) as ScalarValue<K> | undefined;
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
	const tryRead = (p: string): string | undefined | null => readPrivate(p, name);
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

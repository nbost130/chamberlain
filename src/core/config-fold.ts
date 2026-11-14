/** Reading the old files into the document a migration plans (./config-plan.ts): each old setting, thread id and daemon.env variable folded into it. */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Plan } from "./config-plan.ts";
import { envNumber } from "./layout.ts";
import { legacyValue, oldFileState } from "./layout-legacy.ts";
import {
	ENV_KEYS,
	LEGACY_THREAD_FILES,
	SCALARS,
	type ScalarKey,
	type ScalarKind,
	THREADS,
	type ThreadKey,
} from "./layout-schema.ts";
import { isPrivateFile, modeText } from "./private.ts";

export const isObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** Pure: JSON with the keys sorted, so two values compare equal whatever the order they were written in. */
const canonical = (v: unknown): string =>
	JSON.stringify(v, (_k, x) =>
		isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
	);

/** Every key that came from the old settings.json, in the order they are written. */
const SETTINGS_KEYS = ["principal", "t3Dir", "t3StateDb", "alertCmd", "compactTokens", "settledMatch"];
/** Sections that each came from one old file (the thread ids are handled apart). */
const FILE_SECTIONS = ["servers", "web", "sweep", "alertDesk", "operatingRules", "judge"];

/** Pure: the `KEY=value` lines of a systemd EnvironmentFile as pairs, quotes stripped, comments and blank lines dropped. */
export function parseEnvFile(text: string): [string, string][] {
	const out: [string, string][] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		const [, name, rawValue] = m ?? [];
		if (name === undefined || rawValue === undefined) continue;
		let v = rawValue.trim();
		if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
			v = v.slice(1, -1);
		out.push([name, v]);
	}
	return out;
}

/** Pure: a comma-separated value as a list, or undefined when it names nothing. */
function envList(raw: string): string[] | undefined {
	const l = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return l.length ? l : undefined;
}

/** Pure: an environment value as the typed value its key takes, or undefined when it is not usable. */
export function envValue(key: ScalarKey, raw: string): unknown {
	const kind: ScalarKind = SCALARS[key];
	if (kind === "string") return raw.trim() ? raw : undefined;
	if (kind === "boolean") return raw === "1" ? true : raw === "0" ? false : undefined;
	if (kind === "list") return envList(raw);
	return envNumber(raw, kind);
}

/** What a plan is built over: the directory, the config.json that exists, the document the plan grows, and the plan. */
export type PlanCtx = {
	conf: string;
	existing: Record<string, unknown> | undefined;
	doc: Record<string, unknown>;
	plan: Plan;
};

/** Takes one value from an old file: added when config.json lacks the key, reported when it holds another value, a problem when the file is not trusted. */
function foldKey(
	{ doc, plan }: PlanCtx,
	key: string,
	{ file: from, value, trust }: { file: string; value: unknown; trust?: string },
) {
	if (trust) {
		plan.problems.push(
			`${from}: ${trust}. It is not migrated, because config.json is trusted and this file was not: fix the file (or move its contents into config.json yourself) and run again`,
		);
		return;
	}
	if (Object.hasOwn(doc, key)) {
		if (canonical(doc[key]) !== canonical(value)) plan.differs.push({ key, from });
		return;
	}
	doc[key] = value;
	plan.added.push({ key, from });
}

/** The old file's value for a key; a file that cannot be read is a problem, not a throw. */
function legacyOf({ conf, plan }: PlanCtx, key: string) {
	try {
		return legacyValue(conf, key);
	} catch (e) {
		plan.problems.push(String((e as Error).message ?? e).slice(0, 300));
		return undefined;
	}
}

/** The keys of settings.json that this build does not read. */
const KNOWN_SETTINGS_KEYS = new Set([
	"schemaVersion",
	"principalName",
	"t3BaseDir",
	"t3StateDb",
	"alertCommand",
	"compactTokens",
	"settledMatch",
]);

/** Says which keys of a usable settings.json are not migrated, because this build does not read them. */
export function noteUnreadSettings(conf: string, plan: Plan) {
	try {
		const p = `${conf}/settings.json`;
		if (oldFileState(conf, "settings.json", false) === "usable" && isPrivateFile(statSync(p))) {
			const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
			const extra = isObject(raw) ? Object.keys(raw).filter((k) => !KNOWN_SETTINGS_KEYS.has(k)) : [];
			if (extra.length)
				plan.notes.push(
					`settings.json: ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not read by this build, so not migrated`,
				);
		}
	} catch {
		// EMPTY_CATCH_OK: a settings.json that cannot be read is reported by the migration of its keys just below.
	}
}

/** Every settings key and every one-file section, from the old files. */
export function foldLegacyKeys(ctx: PlanCtx) {
	for (const key of [...SETTINGS_KEYS, ...FILE_SECTIONS]) {
		const v = legacyOf(ctx, key);
		if (v) foldKey(ctx, key, v);
	}
}

/** The thread id in a member's old file; a file that cannot be read is a problem, not a throw. */
function legacyThreadIdOf({ conf, plan }: PlanCtx, member: ThreadKey): string | undefined {
	try {
		return legacyThreadId(conf, member);
	} catch (e) {
		plan.problems.push(String((e as Error).message ?? e).slice(0, 300));
		return undefined;
	}
}

/** One thread id: added when config.json has none for the member, reported when it holds another. */
function foldThreadId({ doc, plan }: PlanCtx, member: ThreadKey, id: string) {
	if (!isObject(doc.threads)) doc.threads = {};
	const t = doc.threads as Record<string, unknown>;
	if (Object.hasOwn(t, member)) {
		if (t[member] !== id) plan.differs.push({ key: `threads.${member}`, from: LEGACY_THREAD_FILES[member] });
	} else {
		t[member] = id;
		plan.added.push({ key: `threads.${member}`, from: LEGACY_THREAD_FILES[member] });
	}
}

/** The three thread ids from their old files, unless config.json says there are none. */
export function foldThreadIds(ctx: PlanCtx) {
	const { existing } = ctx;
	const threadsNone = existing !== undefined && Object.hasOwn(existing, "threads") && existing.threads === null;
	for (const member of threadsNone ? [] : THREADS) {
		const id = legacyThreadIdOf(ctx, member);
		if (id) foldThreadId(ctx, member, id);
	}
}

/** One daemon.env variable: copied when it has a key and a usable value config.json lacks. True when it has no key (it stays in the file). */
function foldEnvVar({ doc, plan }: PlanCtx, name: string, raw: string): boolean {
	const key = ENV_KEYS[name];
	if (!key) return true;
	const v = envValue(key, raw);
	if (v === undefined) {
		plan.notes.push(`daemon.env: ${name} holds a value this build cannot use; not copied`);
		return false;
	}
	if (Object.hasOwn(doc, key) && canonical(doc[key]) !== canonical(v)) {
		plan.differs.push({ key, from: `daemon.env ${name}` });
		return false;
	}
	if (!Object.hasOwn(doc, key)) {
		doc[key] = v;
		plan.added.push({ key, from: `daemon.env ${name}` });
	}
	return false;
}

// daemon.env is systemd's own file and stays; the settings in it that have a key are copied, so config.json holds them when it is removed.
export function foldDaemonEnv(ctx: PlanCtx) {
	const { conf, plan } = ctx;
	const envFile = `${conf}/daemon.env`;
	if (!existsSync(envFile)) return;
	if (!isPrivateFile(statSync(envFile))) {
		plan.problems.push("daemon.env: not read, because it is not a private regular file (mode exactly 0600)");
		return;
	}
	let others = 0;
	for (const [name, raw] of parseEnvFile(readFileSync(envFile, "utf8"))) if (foldEnvVar(ctx, name, raw)) others++;
	if (others)
		plan.notes.push(
			`daemon.env: ${others} other variable${others === 1 ? "" : "s"} stay${others === 1 ? "s" : ""} there`,
		);
}

function legacyThreadId(conf: string, member: ThreadKey): string | undefined {
	const name = LEGACY_THREAD_FILES[member];
	const p = `${conf}/${name}`;
	// Only a file that was never migrated: one a migration moved and something wrote again is never read, here or anywhere.
	if (oldFileState(conf, name, false) !== "usable") return undefined;
	const st = statSync(p);
	if (!isPrivateFile(st))
		throw Error(`${name} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
	return readFileSync(p, "utf8").trim() || undefined;
}

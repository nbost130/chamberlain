/**
 * Does Claude Code run this build's desk allowlist before every tool call in a project? Read from the settings files that decide it, never
 * taken on trust: the Alert Desk reads alert text someone else wrote, and the hook is what limits what that text can make it run. Anything
 * this cannot read, or does not recognise, is "no".
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { COMMANDS, REPO, selfCommand } from "../../core/config/config.ts";

/** The only environment the hook's command may set: where the desk files a decision, and the extra directories it may read. */
const HOOK_ENV = /^(DESK_ASK_PATH|DESK_LOG_DIRS)=(.*)$/;
/** A hook that times out does not block the call, so a short limit is no proof. */
const MIN_TIMEOUT_S = 5;
const MAX_SETTINGS = 1024 * 1024;
const HOOK_KEYS = new Set(["type", "command", "timeout", "async"]);
const ENTRY_KEYS = new Set(["matcher", "hooks"]);
/** Claude Code skips a whole settings file that has one invalid value. So the file that proves the hook holds the hook and nothing else. */
const FILE_KEYS = new Set(["$schema", "hooks"]);
const EVENTS = new Set(["PreToolUse"]);

type Obj = Record<string, unknown>;
type Entry = { matcher?: unknown; hooks: Obj[] };
type Build = { home: string; repo: string; binary?: string };
export type DeskHookEnv = Record<string, string>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, keys: Set<string>) => Object.keys(o).every((k) => keys.has(k));
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Where an administrator's settings are kept: the file, its drop-in directory, and the cache of what a server sent. */
function managedFiles(home: string): string[] {
	const dropIns = "/etc/claude-code/managed-settings.d";
	return [
		"/etc/claude-code/managed-settings.json",
		...(existsSync(dropIns) ? readdirSync(dropIns).map((name) => join(dropIns, name)) : []),
		join(home, ".claude/remote-settings.json"),
	];
}

/** An absent file sets nothing. One that cannot be read or parsed throws: what it sets is unknown. */
function settings(path: string): Obj {
	if (!existsSync(path)) return {};
	if (statSync(path).size > MAX_SETTINGS) throw Error("settings file is too large to vouch for");
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isObj(value)) throw Error("settings file is not an object");
	return value;
}

/** The characters a plain command is made of. A list of what is allowed: a list of what a shell interprets can miss one. */
const PLAIN = /^[A-Za-z0-9 _./:=",@+-]*$/;

/** The words of a plain command: double quotes and $HOME only. Anything else is refused. */
function words(command: string, home: string): string[] | undefined {
	const text = command.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
	if (!PLAIN.test(text) || (text.match(/"/g)?.length ?? 0) % 2) return undefined;
	return [...text.matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) => m[0].replaceAll('"', ""));
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** The installed binary's own spellings. The name on PATH, or the path given, must be the binary this process runs from. */
function runsBinary(argv: string[], binary: string | undefined): boolean {
	const [name = "", ...rest] = argv;
	if (!binary || !(equal(rest, ["desk-allowlist", "hook"]) || equal(rest, ["debug", "desk-allowlist", "hook"])))
		return false;
	const path = name === "chamberlain" ? Bun.which(name) : name;
	return path?.startsWith("/") === true && samePath(path, binary);
}

const isBun = (name = "") => name === "bun" || (name.startsWith("/") && basename(name) === "bun");

/** Is this the allowlist hook of this build: from its checkout, or from the installed binary? */
function runsAllowlist(argv: string[], build: Build): boolean {
	if (runsBinary(argv, build.binary)) return true;
	const [bun, script = "", mode] = argv;
	const own = script.startsWith("/") && samePath(script, join(build.repo, COMMANDS["desk-allowlist"]));
	return argv.length === 3 && isBun(bun) && own && mode === "hook";
}

/** The environment a proven hook command runs with, or undefined when the command is not this build's allowlist. */
function hookEnv(command: unknown, build: Build): DeskHookEnv | undefined {
	const argv = typeof command === "string" ? words(command, build.home) : undefined;
	if (!argv) return undefined;
	if (argv[0] === "env") argv.shift();
	const env: DeskHookEnv = {};
	for (let m = argv[0]?.match(HOOK_ENV); m; m = argv[0]?.match(HOOK_ENV)) {
		env[m[1] as string] = m[2] as string;
		argv.shift();
	}
	return runsAllowlist(argv, build) ? env : undefined;
}

const everyTool = (matcher: unknown) => matcher === undefined || ["", "*", ".*"].includes(matcher as string);
const longEnough = (timeout: unknown) =>
	timeout === undefined || (typeof timeout === "number" && timeout >= MIN_TIMEOUT_S);

/** A well-formed blocking command hook: no condition, no background run, no field this does not know. */
const blocking = (hook: unknown): hook is Obj =>
	isObj(hook) &&
	onlyKeys(hook, HOOK_KEYS) &&
	hook.type === "command" &&
	typeof hook.command === "string" &&
	(hook.async === undefined || hook.async === false) &&
	longEnough(hook.timeout);

const wellFormed = (entry: unknown): entry is Entry =>
	isObj(entry) &&
	onlyKeys(entry, ENTRY_KEYS) &&
	(entry.matcher === undefined || typeof entry.matcher === "string") &&
	Array.isArray(entry.hooks) &&
	entry.hooks.every(blocking);

/** The file's PreToolUse entries, when the whole file is one this can vouch for. */
function provingEntries(s: Obj): Entry[] {
	const entries = isObj(s.hooks) && onlyKeys(s.hooks, EVENTS) ? s.hooks.PreToolUse : undefined;
	return onlyKeys(s, FILE_KEYS) && Array.isArray(entries) && entries.every(wellFormed) ? entries : [];
}

function provenEnv(s: Obj, build: Build): DeskHookEnv | undefined {
	for (const entry of provingEntries(s).filter((e) => everyTool(e.matcher)))
		for (const hook of entry.hooks) {
			const env = hookEnv(hook.command, build);
			if (env) return env;
		}
	return undefined;
}

/** Any value but `false` is taken as on: one this does not understand may be. */
const on = (value: unknown) => value !== undefined && value !== false;

type Where = { home: string; repo?: string; managed?: string[]; binary?: string };
const here = (): Where => ({
	home: process.env.HOME ?? "",
	...(selfCommand("desk-allowlist").startsWith("chamberlain ") ? { binary: process.execPath } : {}),
});

/** The hook's environment when it is installed and nothing turns it off; undefined otherwise. */
export function deskHook(root: string, o: Where = here()): DeskHookEnv | undefined {
	try {
		const managed = (o.managed ?? managedFiles(o.home)).map(settings);
		const project = settings(join(root, ".claude/settings.json"));
		const local = settings(join(root, ".claude/settings.local.json"));
		const user = settings(join(o.home, ".claude/settings.json"));
		if (managed.some((s) => on(s.allowManagedHooksOnly))) return undefined;
		if ([...managed, project, local, user].some((s) => on(s.disableAllHooks))) return undefined;
		const build = { home: o.home, repo: o.repo ?? REPO, binary: o.binary };
		return provenEnv(project, build) ?? provenEnv(local, build);
	} catch {
		// Unreadable settings: what they set is unknown.
		return undefined;
	}
}

/**
 * Does Claude Code run this build's desk allowlist before every tool call in a project? Read from the settings files that decide it, never
 * taken on trust: the Alert Desk reads alert text someone else wrote, and the hook is what limits what that text can make it run. Anything
 * this cannot read, or does not recognise, is "no".
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { COMMANDS, REPO } from "../../core/config/config.ts";

const MANAGED = "/etc/claude-code/managed-settings.json";
/** The only environment the hook's command may set: where the desk files a decision, and the extra directories it may read. */
const HOOK_ENV = /^(DESK_ASK_PATH|DESK_LOG_DIRS)=(.*)$/;
/** A hook that times out does not block the call, so a short limit is no proof. */
const MIN_TIMEOUT_S = 5;
const HOOK_KEYS = new Set(["type", "command", "timeout", "statusMessage"]);
const ENTRY_KEYS = new Set(["matcher", "hooks"]);

type Obj = Record<string, unknown>;
export type DeskHookEnv = Record<string, string>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, keys: Set<string>) => Object.keys(o).every((k) => keys.has(k));

/** An absent file sets nothing. One that cannot be read or parsed throws: what it sets is unknown. */
function settings(path: string): Obj {
	if (!existsSync(path)) return {};
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isObj(value)) throw Error("settings file is not an object");
	return value;
}

/** The words of a plain command: double quotes and $HOME only. Anything else a shell would interpret is refused. */
function words(command: string, home: string): string[] | undefined {
	const text = command.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
	if (/[`$;|&<>()'*?[\]{}~#!\n\r]/.test(text) || (text.match(/"/g)?.length ?? 0) % 2) return undefined;
	return [...text.matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) => m[0].replaceAll('"', ""));
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** Is this the allowlist hook of this build: from its checkout, or from the installed binary? */
function runsAllowlist(argv: string[], repo: string): boolean {
	if (["chamberlain desk-allowlist hook", "chamberlain debug desk-allowlist hook"].includes(argv.join(" ")))
		return true;
	const [bun, script, mode] = argv;
	return (
		argv.length === 3 &&
		(bun === "bun" || (bun?.startsWith("/") === true && basename(bun) === "bun")) &&
		script?.startsWith("/") === true &&
		samePath(script, join(repo, COMMANDS["desk-allowlist"])) &&
		mode === "hook"
	);
}

/** The environment a proven hook command runs with, or undefined when the command is not this build's allowlist. */
function hookEnv(command: unknown, home: string, repo: string): DeskHookEnv | undefined {
	const argv = typeof command === "string" ? words(command, home) : undefined;
	if (!argv) return undefined;
	if (argv[0] === "env") argv.shift();
	const env: DeskHookEnv = {};
	for (let m = argv[0]?.match(HOOK_ENV); m; m = argv[0]?.match(HOOK_ENV)) {
		env[m[1] as string] = m[2] as string;
		argv.shift();
	}
	return runsAllowlist(argv, repo) ? env : undefined;
}

const everyTool = (matcher: unknown) => matcher === undefined || ["", "*", ".*"].includes(matcher as string);
const longEnough = (timeout: unknown) =>
	timeout === undefined || (typeof timeout === "number" && timeout >= MIN_TIMEOUT_S);

/** A blocking command hook on every tool: no narrower matcher, no condition, no background run, no field this does not know. */
function entryEnv(entry: unknown, home: string, repo: string): DeskHookEnv | undefined {
	if (!isObj(entry) || !onlyKeys(entry, ENTRY_KEYS) || !everyTool(entry.matcher) || !Array.isArray(entry.hooks))
		return undefined;
	for (const hook of entry.hooks as unknown[]) {
		if (!isObj(hook) || !onlyKeys(hook, HOOK_KEYS) || hook.type !== "command" || !longEnough(hook.timeout)) continue;
		const env = hookEnv(hook.command, home, repo);
		if (env) return env;
	}
	return undefined;
}

function preToolUse(s: Obj): unknown[] {
	const entries = isObj(s.hooks) ? s.hooks.PreToolUse : undefined;
	return Array.isArray(entries) ? entries : [];
}

/** The hook's environment when it is installed and nothing turns it off; undefined otherwise. */
export function deskHook(
	root: string,
	o: { home: string; repo?: string; managed?: string } = { home: process.env.HOME ?? "" },
): DeskHookEnv | undefined {
	try {
		const managed = settings(o.managed ?? MANAGED);
		const own = [settings(join(root, ".claude/settings.json")), settings(join(root, ".claude/settings.local.json"))];
		const user = [settings(join(o.home, ".claude/settings.json"))];
		if (managed.allowManagedHooksOnly === true) return undefined;
		if ([managed, ...own, ...user].some((s) => s.disableAllHooks === true)) return undefined;
		for (const entry of own.flatMap(preToolUse)) {
			const env = entryEnv(entry, o.home, o.repo ?? REPO);
			if (env) return env;
		}
	} catch {
		// Unreadable settings: what they set is unknown.
	}
	return undefined;
}

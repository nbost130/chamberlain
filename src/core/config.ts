/**
 * Where Chamberlain keeps its files, and the few settings every module shares.
 *
 *   CHAMBERLAIN_CONF   config directory, default $XDG_CONFIG_HOME/chamberlain, i.e. ~/.config/chamberlain (secrets and settings, mode 0600 files)
 *   CHAMBERLAIN_STATE  state directory, default $XDG_STATE_HOME/chamberlain, i.e. ~/.local/state/chamberlain (the database,
 *                      the evidence files, the hand-off): durable data that survives restarts but is not user-edited config
 *
 * `settings.json` in the config directory (mode 0600) holds the rest, and each value can be overridden by an environment
 * variable. See README.md, "Configuration reference".
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isPrivateFile, modeText } from "./private.ts";
import { SCHEMA_VERSION, checkVersion } from "./schema.ts";
import { configDir, stateDir } from "./state-dir.ts";

const HOME = process.env.HOME!;
export const CONF = configDir(process.env, HOME);
export const STATE = stateDir(process.env, HOME);
/** This checkout: the Steward's wakes and hand-off name the CLI tools by this path. In a compiled binary it is a path inside the binary, so nothing may build a command from it: use `selfCommand`. */
export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** True when this is the standalone binary made by `bun build --compile` (src/cli.ts), whose sources live under Bun's embedded `$bunfs`, not in a checkout. */
const COMPILED = import.meta.url.includes("/$bunfs/");
let forced: boolean | undefined;
/** Whether commands are rendered for the compiled binary. For tests: `setCompiled(true)` renders as the binary would, `setCompiled()` goes back to the truth. */
export const setCompiled = (v?: boolean): void => { forced = v; };
export const isCompiled = (): boolean => forced ?? COMPILED;

/**
 * Every command-line tool, by the subcommand `chamberlain <sub>` runs it as (src/cli.ts) and the source file `bun <checkout>/<file>` runs from a checkout.
 * The one table: the dispatcher's loaders and every command string an agent or an operator is shown come from it.
 */
export const COMMANDS = {
	daemon: "src/daemon.ts",
	web: "src/web/server.ts",
	ask: "src/ask.ts",
	afk: "src/core/afk.ts",
	decided: "src/core/decided.ts",
	ruling: "src/core/ruling.ts",
	butler: "src/core/butler.ts",
	migrate: "src/core/migrate.ts",
	brief: "src/brief.ts",
	wakes: "src/wakes.ts",
	"steward-health": "src/steward-health.ts",
	"desk-allowlist": "src/desk-allowlist.ts",
	peek: "src/adapters/t3/peek.ts",
	t3x: "src/adapters/t3/t3x.ts",
	compat: "src/adapters/t3/compat.ts",
	"queue-waits": "src/adapters/t3/queue-waits.ts",
	"switch-steward": "src/adapters/t3/switch-steward.ts",
	"synthetic-wake": "src/adapters/t3/synthetic-wake.ts",
} as const;
export type CommandName = keyof typeof COMMANDS;

/**
 * The commands for diagnosing and for the Steward's own reads, not for everyday use. The binary runs them as `chamberlain debug <name>` and
 * keeps `chamberlain <name>` working as a hidden alias, so a prompt written before the grouping still runs.
 */
export const DEBUG_COMMANDS = ["t3x", "peek", "queue-waits", "compat", "desk-allowlist", "synthetic-wake"] as const satisfies readonly CommandName[];
export const isDebugCommand = (sub: string): boolean => (DEBUG_COMMANDS as readonly string[]).includes(sub);
/** The words after `chamberlain` that run tool `sub`: the name, behind `debug` for a debug command. */
export const binaryWords = (sub: CommandName): string[] => (isDebugCommand(sub) ? ["debug", sub] : [sub]);

/**
 * The command that runs tool `sub`, as an agent or operator types it, without its arguments: `chamberlain <sub>` from the compiled
 * binary, `bun <checkout>/<file>` from source. The one place a command string is built; `compiled` and `repo` are for tests and for callers
 * that were handed another checkout's path.
 */
export function selfCommand(sub: CommandName, o: { compiled?: boolean; repo?: string } = {}): string {
	return (o.compiled ?? isCompiled()) ? `chamberlain ${binaryWords(sub).join(" ")}` : `bun ${o.repo ?? REPO}/${COMMANDS[sub]}`;
}

/** What the wakes call the human when no `principalName` is configured. */
export const DEFAULT_PRINCIPAL = "the operator";

export type Settings = {
	schemaVersion?: number;
	/** What the Steward's wakes and hand-off call the human it works for: "Ada", "the operator". */
	principalName?: string;
	/** The T3 adapter's: T3's base directory. Default ~/.t3. */
	t3BaseDir?: string;
	/** The T3 adapter's: T3's state database. Default <t3BaseDir>/userdata/statev2.sqlite. */
	t3StateDb?: string;
	/** A command run for each alarm as `<command> <severity> <title> <summary>`. Without one, alarms are only logged. */
	alertCommand?: string;
	/** The Steward's context size, in tokens, past which the daemon sends a compact. Default 350000. */
	compactTokens?: number;
	/** How ask.ts and `afk.ts hold` decide a question is already settled (src/core/settled.ts). */
	settledMatch?: SettledMatch;
};
/**
 * The settled check's one tunable rule. `titleOverlap: false` matches on exact refs only (a commit, a run, an item, or a PR,
 * branch or thread beside the same topic). `ignoreWords` are words that head many unrelated questions in your setup (a
 * project or product name), so sharing one says nothing about the topic.
 */
export type SettledMatch = { titleOverlap?: boolean; ignoreWords?: string[] };

/** Pure: the settings a parsed file holds, or the first thing wrong with it. */
export function parseSettings(raw: unknown): Settings {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Error("settings.json: expected a JSON object");
	const o = raw as Record<string, unknown>;
	checkVersion("settings.json", o.schemaVersion);
	const str = (k: string) => {
		const v = o[k];
		if (v === undefined) return undefined;
		if (typeof v !== "string" || !v.trim()) throw Error(`settings.json: "${k}" must be a non-empty string`);
		return v.trim();
	};
	const compactTokens = o.compactTokens;
	if (compactTokens !== undefined && (typeof compactTokens !== "number" || !Number.isFinite(compactTokens) || compactTokens <= 0)) throw Error('settings.json: "compactTokens" must be a positive number');
	const sm = o.settledMatch;
	let settledMatch: SettledMatch | undefined;
	if (sm !== undefined) {
		if (sm === null || typeof sm !== "object" || Array.isArray(sm)) throw Error('settings.json: "settledMatch" must be an object');
		const { titleOverlap, ignoreWords, ...extra } = sm as Record<string, unknown>;
		if (Object.keys(extra).length) throw Error(`settings.json: "settledMatch" has unknown keys: ${Object.keys(extra).join(", ")}`);
		if (titleOverlap !== undefined && typeof titleOverlap !== "boolean") throw Error('settings.json: "settledMatch.titleOverlap" must be true or false');
		if (ignoreWords !== undefined && (!Array.isArray(ignoreWords) || ignoreWords.some((w) => typeof w !== "string" || !w.trim()))) throw Error('settings.json: "settledMatch.ignoreWords" must be a list of words');
		settledMatch = { ...(titleOverlap !== undefined ? { titleOverlap } : {}), ...(ignoreWords !== undefined ? { ignoreWords: (ignoreWords as string[]).map((w) => w.trim()) } : {}) };
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		...(str("principalName") ? { principalName: str("principalName") } : {}),
		...(str("t3BaseDir") ? { t3BaseDir: str("t3BaseDir") } : {}),
		...(str("t3StateDb") ? { t3StateDb: str("t3StateDb") } : {}),
		...(str("alertCommand") ? { alertCommand: str("alertCommand") } : {}),
		...(compactTokens !== undefined ? { compactTokens: compactTokens as number } : {}),
		...(settledMatch ? { settledMatch } : {}),
	};
}

let cached: { conf: string; settings: Settings } | undefined;
/** The settings file, or {} when there is none. A file that is not a private regular file (0600) is refused. */
export function readSettings(conf = CONF): Settings {
	if (cached?.conf === conf) return cached.settings;
	const p = `${conf}/settings.json`;
	let settings: Settings = {};
	if (existsSync(p)) {
		const st = statSync(p);
		if (!isPrivateFile(st)) throw Error(`${p} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)}): chmod 600 it first.`);
		settings = parseSettings(JSON.parse(readFileSync(p, "utf8")));
	}
	cached = { conf, settings };
	return settings;
}
/** For tests: forget the cached settings file. */
export const resetSettings = () => { cached = undefined; };

/** A leading ~ is the home directory. */
export const tilde = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

export const alertCommand = (): string | undefined => { const v = process.env.CHAMBERLAIN_ALERT_CMD ?? readSettings().alertCommand; return v ? tilde(v) : undefined; };
export const compactTokens = (fallback: number): number => Number(process.env.CHAMBERLAIN_COMPACT_TOKENS ?? readSettings().compactTokens ?? fallback);

/** What wakes call the human: CHAMBERLAIN_PRINCIPAL, then `principalName` in settings.json, then "the operator". */
export const principal = (): string => (process.env.CHAMBERLAIN_PRINCIPAL ?? readSettings().principalName ?? DEFAULT_PRINCIPAL).trim() || DEFAULT_PRINCIPAL;
/** The same, for the start of a sentence. */
export const Principal = (): string => { const p = principal(); return p[0]!.toUpperCase() + p.slice(1); };
/** The possessive: "Ada's", "the operator's". */
export const principalPoss = (): string => `${principal()}'s`;
export const PrincipalPoss = (): string => `${Principal()}'s`;

/** The argv that runs tool `sub` as a child process: the binary itself with the subcommand when compiled, else this runtime on the source file. */
export function selfArgv(sub: CommandName, o: { compiled?: boolean; repo?: string } = {}): string[] {
	return (o.compiled ?? isCompiled()) ? [process.execPath, ...binaryWords(sub)] : [process.execPath, `${o.repo ?? REPO}/${COMMANDS[sub]}`];
}

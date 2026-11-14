/**
 * Where Chamberlain keeps its files, and the few settings every module shares.
 *
 *   CHAMBERLAIN_CONF   config directory, default $XDG_CONFIG_HOME/chamberlain, i.e. ~/.config/chamberlain (config.json and secrets/)
 *   CHAMBERLAIN_STATE  state directory, default $XDG_STATE_HOME/chamberlain, i.e. ~/.local/state/chamberlain (the database,
 *                      the evidence files, the hand-off): durable data that survives restarts but is not user-edited config
 *
 * `config.json` in the config directory holds every setting that is not a secret, `secrets/` the tokens and webhook URLs, and a scalar
 * key can be overridden by an environment variable (src/core/layout.ts). See docs/CONFIGURATION.md.
 */
import { cfg } from "./layout.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import type { Settings, SettledMatch } from "./settings-parse.ts";
export { parseSettings } from "./settings-parse.ts";
export type { Settings, SettledMatch } from "./settings-parse.ts";
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
export const setCompiled = (v?: boolean): void => {
	forced = v;
};
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
	config: "src/core/config-cmd.ts",
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
export const DEBUG_COMMANDS = [
	"t3x",
	"peek",
	"queue-waits",
	"compat",
	"desk-allowlist",
	"synthetic-wake",
] as const satisfies readonly CommandName[];
export const isDebugCommand = (sub: string): boolean => (DEBUG_COMMANDS as readonly string[]).includes(sub);
/** The words after `chamberlain` that run tool `sub`: the name, behind `debug` for a debug command. */
export const binaryWords = (sub: CommandName): string[] => (isDebugCommand(sub) ? ["debug", sub] : [sub]);

/**
 * The command that runs tool `sub`, as an agent or operator types it, without its arguments: `chamberlain <sub>` from the compiled
 * binary, `bun <checkout>/<file>` from source. The one place a command string is built; `compiled` and `repo` are for tests and for callers
 * that were handed another checkout's path.
 */
export function selfCommand(sub: CommandName, o: { compiled?: boolean; repo?: string } = {}): string {
	return (o.compiled ?? isCompiled())
		? `chamberlain ${binaryWords(sub).join(" ")}`
		: `bun ${o.repo ?? REPO}/${COMMANDS[sub]}`;
}

/** What the wakes call the human when no `principalName` is configured. */
export const DEFAULT_PRINCIPAL = "the operator";

let cached: { conf: string; settings: Settings } | undefined;
/**
 * The settings view of the config: principal, t3Dir, t3StateDb, alertCmd, compactTokens and settledMatch, from config.json, else the legacy
 * settings.json (src/core/layout.ts). Environment overrides are applied by the callers below, not here. Cached per directory.
 */
export function readSettings(conf = CONF): Settings {
	if (cached?.conf === conf) return cached.settings;
	const g = (k: string) => cfg(conf, k);
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const tokens = g("compactTokens");
	const settings: Settings = {
		...(str(g("principal")) ? { principalName: str(g("principal")) } : {}),
		...(str(g("t3Dir")) ? { t3BaseDir: str(g("t3Dir")) } : {}),
		...(str(g("t3StateDb")) ? { t3StateDb: str(g("t3StateDb")) } : {}),
		...(str(g("alertCmd")) ? { alertCommand: str(g("alertCmd")) } : {}),
		...(typeof tokens === "number" ? { compactTokens: tokens } : {}),
		...(g("settledMatch") ? { settledMatch: g("settledMatch") as SettledMatch } : {}),
	};
	if (Object.keys(settings).length) settings.schemaVersion = SCHEMA_VERSION;
	cached = { conf, settings };
	return settings;
}
/** For tests: forget the cached settings file. */
export const resetSettings = () => {
	cached = undefined;
};

/** A leading ~ is the home directory. */
export const tilde = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

export const alertCommand = (): string | undefined => {
	const v = process.env.CHAMBERLAIN_ALERT_CMD ?? readSettings().alertCommand;
	return v ? tilde(v) : undefined;
};
export const compactTokens = (fallback: number): number =>
	Number(process.env.CHAMBERLAIN_COMPACT_TOKENS ?? readSettings().compactTokens ?? fallback);

/** What wakes call the human: CHAMBERLAIN_PRINCIPAL, then `principalName` in settings.json, then "the operator". */
export const principal = (): string =>
	(process.env.CHAMBERLAIN_PRINCIPAL ?? readSettings().principalName ?? DEFAULT_PRINCIPAL).trim() || DEFAULT_PRINCIPAL;
/** The same, for the start of a sentence. */
export const Principal = (): string => {
	const p = principal();
	return p[0]!.toUpperCase() + p.slice(1);
};
/** The possessive: "Ada's", "the operator's". */
export const principalPoss = (): string => `${principal()}'s`;
export const PrincipalPoss = (): string => `${Principal()}'s`;

/** The argv that runs tool `sub` as a child process: the binary itself with the subcommand when compiled, else this runtime on the source file. */
export function selfArgv(sub: CommandName, o: { compiled?: boolean; repo?: string } = {}): string[] {
	return (o.compiled ?? isCompiled())
		? [process.execPath, ...binaryWords(sub)]
		: [process.execPath, `${o.repo ?? REPO}/${COMMANDS[sub]}`];
}

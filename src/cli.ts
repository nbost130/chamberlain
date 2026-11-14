/**
 * The one command: `chamberlain <subcommand> [args]`. Each subcommand is a tool that also runs on its own from a checkout
 * (`bun src/ask.ts ...`); this dispatcher is what the standalone binary (scripts/build.ts) runs, and `bun src/cli.ts <subcommand>` works too.
 * The tools and the source file each one lives in are listed once, in COMMANDS (src/core/config.ts). A subcommand is loaded only when it
 * runs, so `--version` and `help` start without opening anything.
 *
 * The diagnostic commands (DEBUG_COMMANDS) are run as `chamberlain debug <name>`; `chamberlain <name>` still works for them, unlisted.
 */
import pkg from "../package.json" with { type: "json" };
import { COMMANDS, type CommandName, DEBUG_COMMANDS, isDebugCommand } from "./core/config.ts";

type Tool = { main: (argv: string[]) => unknown };

/** How each subcommand is loaded. Typed against COMMANDS, so a tool added there without a loader here does not compile. */
const LOAD: Record<CommandName, () => Promise<Tool>> = {
	daemon: () => import("./daemon.ts"),
	web: () => import("./web/server.ts"),
	ask: () => import("./ask.ts"),
	afk: () => import("./core/afk.ts"),
	decided: () => import("./core/decided.ts"),
	ruling: () => import("./core/ruling.ts"),
	butler: () => import("./core/butler.ts"),
	migrate: () => import("./core/migrate.ts"),
	config: () => import("./core/config-cmd.ts"),
	brief: () => import("./brief.ts"),
	wakes: () => import("./wakes.ts"),
	"steward-health": () => import("./steward-health.ts"),
	"desk-allowlist": () => import("./desk-allowlist.ts"),
	peek: () => import("./adapters/t3/peek.ts"),
	t3x: () => import("./adapters/t3/t3x.ts"),
	compat: () => import("./adapters/t3/compat.ts"),
	"queue-waits": () => import("./adapters/t3/queue-waits.ts"),
	"switch-steward": () => import("./adapters/t3/switch-steward.ts"),
	"synthetic-wake": () => import("./adapters/t3/synthetic-wake.ts"),
};

/** One line for each subcommand, as `chamberlain help` lists them. */
const ABOUT: Record<CommandName, string> = {
	daemon: "run the daemon: watch T3 and wake the Steward",
	web: "serve the decision-queue page (--test: fixture data, loopback only); web link: print its links with the key; web rotate-token: new key, old links stop",
	ask: "put one question on the decision queue ('<json>' or - for stdin)",
	afk: "away mode and the held ledger: enter|status|hold|held|note|close|close-card|brief|exit",
	decided: "log a self-answer, or list the last ones",
	ruling: "propose a ruling, record one stated in chat, or list them",
	butler: "start, stop or list butler threads",
	migrate: "check every config and state file, and upgrade the old ones",
	config:
		"config migrate|revert [--dry-run]: move the old files into config.json and secrets/, or back; config show; config get <key>",
	brief: "print the Steward's hand-off (steward) or the Alert Desk's prompt (desk)",
	wakes: "wakes that stopped sending: list|retry|cancel",
	"steward-health": "print the Steward's health; steward-health tokens: its token usage per wake (needs stewardTokens)",
	"desk-allowlist": "the Alert Desk's command allowlist: hook|check '<command>'",
	peek: "the end of a thread in plain lines",
	t3x: "act on a T3 thread by hand: threads|read|respond|send",
	compat: "print what a T3 server reports and whether it is in the tested range",
	"queue-waits": "how long wakes waited, from the database and T3's state",
	"switch-steward": "make a thread the wake target: the last step of a hand-off",
	"synthetic-wake": "queue one test wake for the Steward",
};

export const VERSION: string = pkg.version;

const line = (c: CommandName) => `  ${c.padEnd(15)}${ABOUT[c]}`;

export const usage = (): string =>
	[
		`chamberlain ${VERSION}: watches your T3 Code threads and wakes the Steward only when something needs it.`,
		"",
		"usage: chamberlain <command> [args]    chamberlain --version",
		"",
		...(Object.keys(COMMANDS) as CommandName[]).filter((c) => !isDebugCommand(c)).map(line),
		`  ${"debug".padEnd(15)}diagnostic commands: chamberlain debug help`,
	].join("\n");

/** What `chamberlain debug help` prints. */
export const debugUsage = (): string =>
	["usage: chamberlain debug <command> [args]", "", ...DEBUG_COMMANDS.map(line)].join("\n");

/** `debug <sub> ...` is the command `sub`; the help forms and an unknown `sub` are answered here, with the exit code to use. */
function routeDebug(rest: string[]): { cmd: string; rest: string[] } | number {
	const [sub, ...more] = rest;
	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		console.log(debugUsage());
		return sub === undefined ? 2 : 0;
	}
	if (!isDebugCommand(sub)) {
		console.error(`chamberlain: unknown debug command "${sub}"\n\n${debugUsage()}`);
		return 2;
	}
	return { cmd: sub, rest: more };
}

/** Loads one command and runs it. A failing tool prints one line and gives exit 1; the two that stay up keep their stack trace. */
async function runCommand(cmd: CommandName, rest: string[]): Promise<number> {
	try {
		await (await LOAD[cmd]()).main(rest);
	} catch (e) {
		// The tools that run as scripts print an error as one line and exit 1; the two that stay up keep Bun's stack trace for the crash report.
		if (cmd === "daemon" || cmd === "web") throw e;
		console.error(String(e instanceof Error ? e.message : e));
		return 1;
	}
	return 0;
}

/** Runs `chamberlain <argv>`; returns the process exit code to use when the tool does not set one itself. */
export async function run(argv: string[]): Promise<number> {
	let [cmd, ...rest] = argv;
	if (cmd === "debug") {
		const routed = routeDebug(rest);
		if (typeof routed === "number") return routed;
		({ cmd, rest } = routed);
	}
	if (cmd === "--version" || cmd === "-v" || cmd === "version") {
		console.log(VERSION);
		return 0;
	}
	if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(usage());
		return cmd === undefined ? 2 : 0;
	}
	if (!Object.hasOwn(LOAD, cmd)) {
		console.error(`chamberlain: unknown command "${cmd}"\n\n${usage()}`);
		return 2;
	}
	return runCommand(cmd as CommandName, rest);
}

if (import.meta.main) {
	// Read the exit code AFTER the tool ran: `process.exitCode ||= await run(...)` reads it first, and then overwrites what the tool set (exit 1 from `config get`, `config migrate`) with run's 0.
	const code = await run(process.argv.slice(2));
	process.exitCode ||= code;
}

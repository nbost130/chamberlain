/**
 * The one runner for a model that reads untrusted text: the `claude` CLI on the operator's own login, in one-shot print mode, with
 * no tools. The idle-thread classifier (src/core/classifier/providers.ts) and the optional modules (src/modules/) both call it, so the
 * rule that the reading model cannot act is written once, in `claudeArgv`, and checked once, in `assertNoTools`, which `runClaude`
 * runs before anything is spawned:
 *
 *   -p                         one reply, no session
 *   --tools ""                 no tool the model could call
 *   --strict-mcp-config        no MCP server from any config file
 *   --setting-sources ""       no settings, so no hook, no `apiKeyHelper`, no allowed-tool list
 *   --disable-slash-commands   no skill or command
 *   --no-session-persistence   nothing written for a later session to read
 *
 * The text to read goes on stdin, never in argv, where any local user could read it. Errors carry a fixed phrase, an exit code or a
 * timeout, never the CLI's output, which may echo the text. The caller chooses the model and the environment the CLI gets.
 */
import { runPiped } from "./spawn.ts";

/** Runs a command with `stdin` on its input. `code` is null when a signal or the timeout ended it. stderr is dropped. */
export type CliRunner = (
	argv: string[],
	o: { stdin: string; env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

/** What a call cost, when the CLI said. A failed call that was billed still reports it, so a budget counts it. */
export type Usage = { inputTokens?: number; costUsd?: number };

/** A model id as a CLI may report it: a short token of letters, digits and `._:/-`. Anything else is refused, never stored. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Pure: the argv. No settings, tools, MCP servers, slash commands or session file: a bare one-shot reader. */
export const claudeArgv = (o: { command: string; model: string; system: string }): string[] => [
	o.command,
	"-p",
	"--model",
	o.model,
	"--setting-sources",
	"",
	"--tools",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-session-persistence",
	"--system-prompt",
	o.system,
	"--output-format",
	"json",
];

/** The value after a flag in an argv, or undefined when the flag is missing or last. */
const flagValue = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

/** Throws unless the argv keeps the model from acting: no tools and no settings (so no hook), no MCP servers, no commands, no session file. */
export function assertNoTools(argv: string[]): void {
	for (const flag of ["--tools", "--setting-sources"])
		if (!argv.includes(flag) || flagValue(argv, flag) !== "") throw Error(`the model argv must carry ${flag} ""`);
	for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
		if (!argv.includes(flag)) throw Error(`the model argv must carry ${flag}`);
}

/** The real runner. It refuses an argv that would let the model act before it spawns anything, so no caller can reach the CLI without the rule. */
export const spawnCli: CliRunner = async (argv, o) => {
	assertNoTools(argv);
	return runPiped(argv, o.stdin, o.timeoutMs, o.env);
};

export type ClaudeCall = {
	command: string;
	model: string;
	system: string;
	/** The text to read. */
	stdin: string;
	env: Record<string, string | undefined>;
	timeoutMs: number;
	run?: CliRunner;
};

/** The CLI's stdout for one call. A refused argv, a run that cannot start, a timeout and a non-zero exit each throw a fixed phrase, never output. */
export async function runClaude(c: ClaudeCall): Promise<string> {
	const argv = claudeArgv(c);
	assertNoTools(argv);
	let r: Awaited<ReturnType<CliRunner>>;
	try {
		r = await (c.run ?? spawnCli)(argv, { stdin: c.stdin, env: c.env, timeoutMs: c.timeoutMs });
	} catch {
		throw Error(`${c.command} could not be run`);
	}
	if (r.code !== 0)
		throw Error(
			r.code === null ? `${c.command} did not finish within ${c.timeoutMs} ms` : `${c.command} exited ${r.code}`,
		);
	return r.stdout;
}

export type CliReply = {
	result?: unknown;
	total_cost_usd?: unknown;
	usage?: Record<string, unknown>;
	modelUsage?: Record<string, unknown>;
};

/** The CLI's JSON output, which must be an object. */
export function parseReply(command: string, stdout: string): CliReply {
	let j: CliReply;
	try {
		j = JSON.parse(stdout);
	} catch {
		throw Error(`${command} printed something that is not JSON`);
	}
	if (!j || typeof j !== "object") throw Error(`${command} printed JSON that is not an object`);
	return j;
}

const nonNegative = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** What the call cost, from the CLI's own report. Read first: a call whose reply is then refused was still spent. */
export function replyUsage(j: CliReply): Usage {
	const u = j.usage && typeof j.usage === "object" ? j.usage : {};
	const tokens =
		nonNegative(u.input_tokens) + nonNegative(u.cache_creation_input_tokens) + nonNegative(u.cache_read_input_tokens);
	return {
		...(tokens ? { inputTokens: tokens } : {}),
		...(typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd) && j.total_cost_usd >= 0
			? { costUsd: j.total_cost_usd }
			: {}),
	};
}

/** The model ids the reply says answered, in the order reported. Not checked: the caller refuses one that is not a `MODEL_ID`. */
export const reportedModels = (j: CliReply): string[] =>
	j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];

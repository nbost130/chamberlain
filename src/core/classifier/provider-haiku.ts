/** The classifier's haiku provider (./providers.ts): the `claude` CLI on the operator's own login, every question in one call. */
import { type Bank, DATA_PREAMBLE } from "./bank.ts";
import { modelOf, type Provider, ProviderError, type Usage, validAnswers } from "./providers.ts";
import { runPiped } from "./spawn.ts";
import type { SentState } from "./state.ts";

export type CliRunner = (
	argv: string[],
	o: { stdin: string; env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

const spawnCli: CliRunner = (argv, o) => runPiped(argv, o.stdin, o.timeoutMs, o.env);

export type HaikuOptions = { command: string; model: string; timeoutMs: number; run?: CliRunner };

/** Pure: the system prompt: the bank, every question with its yes and no, and the one reply shape. */
const haikuSystem = (bank: Bank): string =>
	"You label one message from an AI agent's chat thread. Answer each question independently with your probability (0 to 1) that the answer is yes.\n\n" +
	bank.map((q) => `- ${q.id}: ${DATA_PREAMBLE} ${q.ask}\n  YES: ${q.yes}\n  NO: ${q.no}`).join("\n") +
	"\n\nReply with only a JSON object mapping each question id to a number, nothing else.";

/** Pure: the argv. No settings, tools, MCP servers, slash commands or session file: a bare one-shot label. */
export const haikuArgv = (o: Pick<HaikuOptions, "command" | "model">, bank: Bank): string[] => [
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
	haikuSystem(bank),
	"--output-format",
	"json",
];

type HaikuReply = {
	result?: unknown;
	total_cost_usd?: unknown;
	usage?: Record<string, unknown>;
	modelUsage?: Record<string, unknown>;
};

/** The CLI's stdout for one thread. A run that cannot start, a timeout and a non-zero exit each throw a fixed phrase, never output. */
async function haikuRun(
	run: CliRunner,
	o: HaikuOptions,
	{ state, bank, env }: { state: SentState; bank: Bank; env: Record<string, string | undefined> },
): Promise<string> {
	let r: Awaited<ReturnType<CliRunner>>;
	try {
		r = await run(haikuArgv(o, bank), { stdin: JSON.stringify({ state }), env, timeoutMs: o.timeoutMs });
	} catch {
		throw Error(`${o.command} could not be run`);
	}
	if (r.code !== 0)
		throw Error(
			r.code === null ? `${o.command} did not finish within ${o.timeoutMs} ms` : `${o.command} exited ${r.code}`,
		);
	return r.stdout;
}

/** The CLI's JSON output, which must be an object. */
function haikuReply(command: string, stdout: string): HaikuReply {
	let j: HaikuReply;
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
function haikuUsage(j: HaikuReply): Usage {
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

/** The first flat `{...}` in the model's reply, parsed, or undefined when there is none or it is not JSON. */
function haikuObject(result: unknown): unknown {
	const m = typeof result === "string" ? result.match(/\{[^{}]*\}/) : null;
	try {
		return m ? JSON.parse(m[0]) : undefined;
	} catch {
		return undefined;
	}
}

/** The probability the model gave each question, checked; a refusal carries the call's usage. */
function haikuAnswers(j: HaikuReply, bank: Bank, usage: Usage): Record<string, number> {
	const parsed = haikuObject(j.result);
	if (parsed === undefined) throw new ProviderError("the model's reply holds no JSON object of answers", usage);
	try {
		return validAnswers(bank, parsed);
	} catch (e) {
		throw new ProviderError((e as Error).message, usage);
	}
}

export function haikuProvider(o: HaikuOptions): Provider {
	const run = o.run ?? spawnCli;
	return {
		name: "haiku",
		model: o.model,
		classify: async (state, bank) => {
			const env: Record<string, string | undefined> = { ...process.env };
			delete env.ANTHROPIC_API_KEY;
			const t0 = performance.now();
			const j = haikuReply(o.command, await haikuRun(run, o, { state, bank, env }));
			const usage = haikuUsage(j);
			const answers = haikuAnswers(j, bank, usage);
			const reported = j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];
			// Every reported model is checked; the first is recorded.
			const models = reported.map((id) => modelOf(id, o.model, usage, o.command));
			return {
				answers,
				model: models[0] ?? o.model,
				...usage,
				latencyMs: Math.round(performance.now() - t0),
			};
		},
	};
}

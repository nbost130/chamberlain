/**
 * The classifier's providers. Each answers every question of a bank about one thread's state with a probability of yes, in ONE call
 * per thread, and nothing else: the action is decided in code (src/core/classifier/bank.ts, `combine`).
 *
 *   rules  regular expressions per question (`looksLikeAsk`, `looksLikeStall`, each question's `rules`). Nothing leaves the machine.
 *   jev    TypeSafe's Jev over plain HTTP: one request per thread, one Noul head per question. Plain `fetch`, not the 0.7.0 SDK, which
 *          under Bun with concurrent requests threw `TypeError: Body already used` on nearly every call (the requests were billed).
 *   haiku  the `claude` CLI on the operator's own login, `--model haiku`, every question in one call. ANTHROPIC_API_KEY is removed
 *          from its environment so it runs on the operator's plan, not `--bare` (bare mode requires an API key). The thread state
 *          goes on stdin, never in argv, where any local user could read it.
 *
 * Every answer is validated: present for every question, a finite number in [0, 1]. A malformed answer throws, and the caller makes the
 * thread `unknown`; a missing answer is never read as no. Errors never carry response bodies or model output, which may echo the
 * thread's text: only a status, an exit code or a fixed phrase.
 */
import { looksLikeAsk, looksLikeStall } from "../decide.ts";
import {
	type CliReply,
	type CliRunner,
	claudeArgv,
	MODEL_ID,
	parseReply,
	replyUsage,
	reportedModels,
	runClaude,
	type Usage,
} from "../llm/cli.ts";
import { type Bank, DATA_PREAMBLE } from "./bank.ts";
import type { SentState } from "./state.ts";

export const PROVIDERS = ["none", "rules", "jev", "haiku"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type ProviderResult = {
	answers: Record<string, number>;
	/** The versioned model id the provider reported. */
	model: string;
	inputTokens?: number;
	costUsd?: number;
	latencyMs: number;
};
export type Provider = {
	name: Exclude<ProviderName, "none">;
	/** The model this provider is pinned to, as configured. Part of the bank version. */
	model: string;
	classify(state: SentState, bank: Bank): Promise<ProviderResult>;
};

/** A provider failure that may carry what the call cost. Its message is a fixed phrase: never a body, model output or the key. */
export class ProviderError extends Error {
	constructor(
		message: string,
		readonly usage: Usage = {},
	) {
		super(message);
		this.name = "ProviderError";
	}
}
/** Pure: the reported model, checked; absent means the configured one. Throws (with the call's usage) for anything else. */
function modelOf(reported: unknown, configured: string, usage: Usage, who: string): string {
	if (reported === undefined || reported === null || reported === "") return configured;
	if (typeof reported !== "string" || !MODEL_ID.test(reported))
		throw new ProviderError(`${who} reported a model id that is not one`, usage);
	return reported;
}

/** Pure: the answers, checked: one finite probability in [0, 1] for every question in the bank. Extra keys are dropped. */
export function validAnswers(bank: Bank, raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("the answers are not an object");
	const o = raw as Record<string, unknown>;
	const out: Record<string, number> = {};
	for (const q of bank) {
		const v = o[q.id];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
			throw Error(`the answer for ${q.id} is missing or not a probability`);
		out[q.id] = v;
	}
	return out;
}

// ---- rules -------------------------------------------------------------------------------------

/** The rules provider: 1 when a question's rules match the last message, else 0. `@otherwise` is yes when no escalate or nudge rule matched. */
export function rulesProvider(): Provider {
	return {
		name: "rules",
		model: "rules",
		classify: async (state, bank) => {
			const t0 = performance.now();
			const text = state.last_message;
			const match = (r: string) =>
				r === "@ask"
					? looksLikeAsk(text)
					: r === "@stall"
						? looksLikeStall(text)
						: r !== "@otherwise" && new RegExp(r, "i").test(text);
			const answers: Record<string, number> = {};
			for (const q of bank) answers[q.id] = (q.rules ?? []).some(match) ? 1 : 0;
			const acted = bank.some((q) => (q.fires === "escalate" || q.fires === "nudge") && answers[q.id] === 1);
			for (const q of bank) if (q.rules?.includes("@otherwise") && !acted) answers[q.id] = 1;
			return { answers, model: "rules", latencyMs: Math.round(performance.now() - t0) };
		},
	};
}

// ---- jev ---------------------------------------------------------------------------------------

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-1.14.0";
/** Input price, USD per million tokens (TypeSafe models page, Jev 1.14). Output is free. Used for any pinned Jev model. */
const JEV_USD_PER_MTOK = 0.042;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type JevOptions = {
	model: string;
	timeoutMs: number;
	/** The API key, read when a call is made (from the key file in the config directory). Undefined: no key, the call fails. */
	key: () => string | undefined;
	fetch?: FetchLike;
};

/** Pure: the request body for one thread: the state once, and one Noul head per question. */
export const jevBody = (state: SentState, bank: Bank, model: string) => ({
	model,
	state,
	questions: Object.fromEntries(
		bank.map((q) => [
			q.id,
			{ type: "noul", instructions: `${DATA_PREAMBLE} ${q.ask}`, criteria: { true: q.yes, false: q.no } },
		]),
	),
});

type JevReply = { answers?: Record<string, { noul?: unknown }>; model?: unknown; usage?: { input_tokens?: unknown } };

/** The one request for a thread. A failure to reach Jev, a timeout and a non-2xx status each throw a fixed phrase, never a body. */
async function jevRequest(
	doFetch: FetchLike,
	o: JevOptions,
	{ key, state, bank }: { key: string; state: SentState; bank: Bank },
): Promise<Response> {
	let r: Response;
	try {
		r = await doFetch(JEV_URL, {
			method: "POST",
			signal: AbortSignal.timeout(o.timeoutMs),
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(jevBody(state, bank, o.model)),
		});
	} catch (e) {
		const name = (e as { name?: string })?.name;
		throw Error(
			name === "TimeoutError" || name === "AbortError"
				? `Jev did not answer within ${o.timeoutMs} ms`
				: "Jev could not be reached",
		);
	}
	if (!r.ok) {
		await r.body?.cancel().catch(() => {});
		throw Error(`Jev answered HTTP ${r.status}`);
	}
	return r;
}

/** The reply's JSON, which must be an object. */
async function jevReply(r: Response): Promise<JevReply> {
	let j: JevReply;
	try {
		j = (await r.json()) as JevReply;
	} catch {
		throw Error("Jev's answer is not JSON");
	}
	if (!j || typeof j !== "object") throw Error("Jev's answer is not an object");
	return j;
}

/** What the call cost: Jev's input tokens at its price. Read first, so a billed call whose answers are then refused still counts against the budget. */
function jevUsage(j: JevReply): Usage {
	const tokens = j.usage?.input_tokens;
	const inputTokens = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
	return inputTokens !== undefined ? { inputTokens, costUsd: (inputTokens * JEV_USD_PER_MTOK) / 1e6 } : {};
}

/** The probability each question's head gave, checked; a refusal carries the call's usage. */
function jevAnswers(j: JevReply, bank: Bank, usage: Usage): Record<string, number> {
	if (!j.answers || typeof j.answers !== "object") throw new ProviderError("Jev's answer has no answers", usage);
	const heads = j.answers as Record<string, { noul?: unknown }>;
	try {
		return validAnswers(bank, Object.fromEntries(bank.map((q) => [q.id, heads[q.id]?.noul])));
	} catch (e) {
		throw new ProviderError((e as Error).message, usage);
	}
}

export function jevProvider(o: JevOptions): Provider {
	const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
	return {
		name: "jev",
		model: o.model,
		classify: async (state, bank) => {
			const key = o.key();
			if (!key) throw Error("no TypeSafe API key (jev.keyFile in the config directory's secrets)");
			const t0 = performance.now();
			const j = await jevReply(await jevRequest(doFetch, o, { key, state, bank }));
			const usage = jevUsage(j);
			const answers = jevAnswers(j, bank, usage);
			return {
				answers,
				model: modelOf(j.model, o.model, usage, "Jev"),
				...usage,
				latencyMs: Math.round(performance.now() - t0),
			};
		},
	};
}

// ---- haiku -------------------------------------------------------------------------------------

export type { CliRunner };
export { MODEL_ID };

export type HaikuOptions = { command: string; model: string; timeoutMs: number; run?: CliRunner };

/** Pure: the system prompt: the bank, every question with its yes and no, and the one reply shape. */
const haikuSystem = (bank: Bank): string =>
	"You label one message from an AI agent's chat thread. Answer each question independently with your probability (0 to 1) that the answer is yes.\n\n" +
	bank.map((q) => `- ${q.id}: ${DATA_PREAMBLE} ${q.ask}\n  YES: ${q.yes}\n  NO: ${q.no}`).join("\n") +
	"\n\nReply with only a JSON object mapping each question id to a number, nothing else.";

/** Pure: the argv: the shared no-tools one-shot reader (src/core/llm/cli.ts), with this bank as its system prompt. */
export const haikuArgv = (o: Pick<HaikuOptions, "command" | "model">, bank: Bank): string[] =>
	claudeArgv({ ...o, system: haikuSystem(bank) });

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
function haikuAnswers(j: CliReply, bank: Bank, usage: Usage): Record<string, number> {
	const parsed = haikuObject(j.result);
	if (parsed === undefined) throw new ProviderError("the model's reply holds no JSON object of answers", usage);
	try {
		return validAnswers(bank, parsed);
	} catch (e) {
		throw new ProviderError((e as Error).message, usage);
	}
}

export function haikuProvider(o: HaikuOptions): Provider {
	return {
		name: "haiku",
		model: o.model,
		classify: async (state, bank) => {
			const env: Record<string, string | undefined> = { ...process.env };
			delete env.ANTHROPIC_API_KEY;
			const t0 = performance.now();
			const stdout = await runClaude({
				...o,
				system: haikuSystem(bank),
				stdin: JSON.stringify({ state }),
				env,
			});
			const j = parseReply(o.command, stdout);
			const usage = replyUsage(j);
			const answers = haikuAnswers(j, bank, usage);
			// Every reported model is checked; the first is recorded.
			const models = reportedModels(j).map((id) => modelOf(id, o.model, usage, o.command));
			return {
				answers,
				model: models[0] ?? o.model,
				...usage,
				latencyMs: Math.round(performance.now() - t0),
			};
		},
	};
}

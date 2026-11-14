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
export const JEV_USD_PER_MTOK = 0.042;

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

export function jevProvider(o: JevOptions): Provider {
	const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
	return {
		name: "jev",
		model: o.model,
		classify: async (state, bank) => {
			const key = o.key();
			if (!key) throw Error("no TypeSafe API key (jev.keyFile in the config directory's secrets)");
			const t0 = performance.now();
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
			let j: { answers?: Record<string, { noul?: unknown }>; model?: unknown; usage?: { input_tokens?: unknown } };
			try {
				j = (await r.json()) as typeof j;
			} catch {
				throw Error("Jev's answer is not JSON");
			}
			if (!j || typeof j !== "object" || !j.answers || typeof j.answers !== "object")
				throw Error("Jev's answer has no answers");
			const answers = validAnswers(
				bank,
				Object.fromEntries(bank.map((q) => [q.id, (j.answers as Record<string, { noul?: unknown }>)[q.id]?.noul])),
			);
			const tokens = j.usage?.input_tokens;
			const inputTokens = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
			return {
				answers,
				model: typeof j.model === "string" && j.model ? j.model.slice(0, 80) : o.model,
				...(inputTokens !== undefined ? { inputTokens, costUsd: (inputTokens * JEV_USD_PER_MTOK) / 1e6 } : {}),
				latencyMs: Math.round(performance.now() - t0),
			};
		},
	};
}

// ---- haiku -------------------------------------------------------------------------------------

export type CliRunner = (
	argv: string[],
	o: { stdin: string; env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

export const spawnCli: CliRunner = async (argv, o) => {
	const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: o.env, timeout: o.timeoutMs });
	p.stdin.write(o.stdin);
	await p.stdin.end();
	const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return { code: p.signalCode ? null : code, stdout };
};

export type HaikuOptions = { command: string; model: string; timeoutMs: number; run?: CliRunner };

/** Pure: the system prompt: the bank, every question with its yes and no, and the one reply shape. */
export const haikuSystem = (bank: Bank): string =>
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

export function haikuProvider(o: HaikuOptions): Provider {
	const run = o.run ?? spawnCli;
	return {
		name: "haiku",
		model: o.model,
		classify: async (state, bank) => {
			const env: Record<string, string | undefined> = { ...process.env };
			delete env.ANTHROPIC_API_KEY;
			const t0 = performance.now();
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
			let j: {
				result?: unknown;
				total_cost_usd?: unknown;
				usage?: Record<string, unknown>;
				modelUsage?: Record<string, unknown>;
			};
			try {
				j = JSON.parse(r.stdout);
			} catch {
				throw Error(`${o.command} printed something that is not JSON`);
			}
			const m = typeof j?.result === "string" ? j.result.match(/\{[^{}]*\}/) : null;
			let parsed: unknown;
			try {
				parsed = m ? JSON.parse(m[0]) : undefined;
			} catch {
				parsed = undefined;
			}
			if (parsed === undefined) throw Error("the model's reply holds no JSON object of answers");
			const answers = validAnswers(bank, parsed);
			const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
			const u = j.usage ?? {};
			const tokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
			const reported = Object.keys(j.modelUsage ?? {})[0];
			return {
				answers,
				model: reported ? reported.slice(0, 80) : o.model,
				...(tokens ? { inputTokens: tokens } : {}),
				...(typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd)
					? { costUsd: j.total_cost_usd }
					: {}),
				latencyMs: Math.round(performance.now() - t0),
			};
		},
	};
}

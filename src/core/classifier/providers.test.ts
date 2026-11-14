import { describe, expect, test } from "bun:test";
import { DEFAULT_BANK, DATA_PREAMBLE } from "./bank.ts";
import {
	type CliRunner,
	type FetchLike,
	haikuArgv,
	haikuProvider,
	JEV_URL,
	jevBody,
	jevProvider,
	MODEL_ID,
	ProviderError,
	rulesProvider,
	validAnswers,
} from "./providers.ts";
import type { SentState } from "./state.ts";

const STATE: SentState = {
	thread_title: "Fix the gate",
	previous_message: { from: "human", text: "is it done?" },
	last_message: "Done. Say go and I'll merge it.",
};
const IDS = DEFAULT_BANK.map((q) => q.id);
const half = Object.fromEntries(IDS.map((id) => [id, 0.5]));
const KEY = ["test", "key", "value"].join("-");

describe("validAnswers: every question, a probability, or a throw", () => {
	test("all present and in [0, 1]; extra keys are dropped", () =>
		expect(validAnswers(DEFAULT_BANK, { ...half, other: 7 })).toEqual(half));
	test("a missing, non-numeric, out-of-range or non-finite answer is never read as no", () => {
		const { asks_decision: _, ...missing } = half;
		for (const bad of [
			missing,
			{ ...half, asks_decision: "0.9" },
			{ ...half, asks_decision: 1.2 },
			{ ...half, asks_decision: -0.1 },
			{ ...half, asks_decision: Number.NaN },
		])
			expect(() => validAnswers(DEFAULT_BANK, bad)).toThrow("asks_decision");
		expect(() => validAnswers(DEFAULT_BANK, null)).toThrow("not an object");
		expect(() => validAnswers(DEFAULT_BANK, [])).toThrow("not an object");
	});
});

describe("jev: one plain-fetch request per thread, one Noul head per question", () => {
	const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const ok = (over: Record<string, number> = {}) =>
		reply({
			model: "jev-1.14.0",
			answers: Object.fromEntries(IDS.map((id) => [id, { noul: over[id] ?? 0.1 }])),
			usage: { input_tokens: 1717 },
		});
	const fake = (r: Response | Error) => {
		const calls: { url: string; init: RequestInit }[] = [];
		const f: FetchLike = async (url, init) => {
			calls.push({ url, init });
			if (r instanceof Error) throw r;
			return r;
		};
		return { f, calls };
	};
	const provider = (f: FetchLike, key: () => string | undefined = () => KEY) =>
		jevProvider({ model: "jev-1.14.0", timeoutMs: 1000, key, fetch: f });

	test("the request: POST to /v1/systemone, the key as a bearer token, the pinned model, the state once, a head per question", async () => {
		const { f, calls } = fake(ok({ asks_decision: 0.98 }));
		const r = await provider(f).classify(STATE, DEFAULT_BANK);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(JEV_URL);
		expect(calls[0]!.init.method).toBe("POST");
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body).toEqual(jevBody(STATE, DEFAULT_BANK, "jev-1.14.0"));
		expect(body.model).toBe("jev-1.14.0");
		expect(body.state).toEqual(STATE);
		expect(Object.keys(body.questions)).toEqual(IDS);
		const head = body.questions.asks_decision;
		expect(head.type).toBe("noul");
		expect(head.instructions.startsWith(DATA_PREAMBLE)).toBe(true);
		expect(head.criteria).toEqual({ true: DEFAULT_BANK[0]!.yes, false: DEFAULT_BANK[0]!.no });
		expect(r.answers.asks_decision).toBe(0.98);
		expect(r.model).toBe("jev-1.14.0");
		expect(r.inputTokens).toBe(1717);
		expect(r.costUsd).toBeCloseTo(1717 * 0.042e-6, 12);
		expect(r.latencyMs).toBeGreaterThanOrEqual(0);
	});
	test("the reported model is recorded, not assumed", async () => {
		const { f } = fake(reply({ model: "jev-1.14.1", answers: Object.fromEntries(IDS.map((id) => [id, { noul: 0 }])) }));
		const r = await provider(f).classify(STATE, DEFAULT_BANK);
		expect(r.model).toBe("jev-1.14.1");
		expect(r.inputTokens).toBeUndefined();
		expect(r.costUsd).toBeUndefined();
	});
	test("no key: no request at all", async () => {
		const { f, calls } = fake(ok());
		await expect(provider(f, () => undefined).classify(STATE, DEFAULT_BANK)).rejects.toThrow("no TypeSafe API key");
		expect(calls).toHaveLength(0);
	});
	test("failures throw a status or a fixed phrase, never the response body or the key", async () => {
		const cases: [Response | Error, string][] = [
			[reply({ error: `Request contains invalid Unicode text: ${STATE.last_message}` }, 400), "Jev answered HTTP 400"],
			[reply({}, 429), "HTTP 429"],
			[new Response("not json", { status: 200 }), "not JSON"],
			[reply({ model: "jev" }), "no answers"],
			[reply({ answers: { asks_decision: { noul: 0.9 } } }), "is missing or not a probability"],
			[reply({ answers: Object.fromEntries(IDS.map((id) => [id, { noul: 2 }])) }), "not a probability"],
			[Object.assign(Error("timed out"), { name: "TimeoutError" }), "did not answer within 1000 ms"],
			[Error(`connect ECONNREFUSED with ${KEY}`), "could not be reached"],
		];
		for (const [r, msg] of cases) {
			const err = await provider(fake(r).f)
				.classify(STATE, DEFAULT_BANK)
				.then(
					() => undefined,
					(e: Error) => e.message,
				);
			expect(err).toContain(msg);
			expect(err).not.toContain(STATE.last_message);
			expect(err).not.toContain(KEY);
		}
	});
});

describe("haiku: the claude CLI on the operator's own login, every question in one call", () => {
	const out = (result: string, extra: object = {}) =>
		JSON.stringify({
			result,
			total_cost_usd: 0.00059,
			usage: { input_tokens: 900, cache_read_input_tokens: 100 },
			modelUsage: { "claude-haiku-5-5": {} },
			...extra,
		});
	const fake = (r: { code: number | null; stdout: string } | Error) => {
		const calls: { argv: string[]; o: Parameters<CliRunner>[1] }[] = [];
		const run: CliRunner = async (argv, o) => {
			calls.push({ argv, o });
			if (r instanceof Error) throw r;
			return r;
		};
		return { run, calls };
	};
	const provider = (run: CliRunner) => haikuProvider({ command: "claude", model: "haiku", timeoutMs: 60_000, run });

	test("the argv is a bare one-shot label; the state goes on stdin; ANTHROPIC_API_KEY is removed", async () => {
		const saved = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "set-for-this-test";
		try {
			const { run, calls } = fake({ code: 0, stdout: out(`Here: ${JSON.stringify({ ...half, asks_decision: 0.9 })}`) });
			const r = await provider(run).classify(STATE, DEFAULT_BANK);
			const { argv, o } = calls[0]!;
			expect(argv).toEqual(haikuArgv({ command: "claude", model: "haiku" }, DEFAULT_BANK));
			expect(argv.slice(0, 4)).toEqual(["claude", "-p", "--model", "haiku"]);
			for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
				expect(argv).toContain(flag);
			expect(argv).not.toContain("--bare");
			expect(argv[argv.indexOf("--tools") + 1]).toBe("");
			expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
			expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
			const system = argv[argv.indexOf("--system-prompt") + 1]!;
			for (const q of DEFAULT_BANK) expect(system).toContain(`- ${q.id}: ${DATA_PREAMBLE} ${q.ask}`);
			// The thread's text is never on the command line, where any local user can read it.
			expect(argv.join(" ")).not.toContain(STATE.last_message);
			expect(o.stdin).toBe(JSON.stringify({ state: STATE }));
			expect("ANTHROPIC_API_KEY" in o.env).toBe(false);
			expect(o.timeoutMs).toBe(60_000);
			expect(r).toMatchObject({
				answers: { ...half, asks_decision: 0.9 },
				model: "claude-haiku-5-5",
				inputTokens: 1000,
				costUsd: 0.00059,
			});
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
		}
	});
	test("an exit, a timeout, unparseable output or a malformed answer throws, without echoing the model's reply", async () => {
		const cases: [Parameters<typeof fake>[0], string][] = [
			[Error("ENOENT"), "claude could not be run"],
			[{ code: 1, stdout: "" }, "claude exited 1"],
			[{ code: null, stdout: "" }, "did not finish within 60000 ms"],
			[{ code: 0, stdout: "plain words" }, "not JSON"],
			[{ code: 0, stdout: out(`I think ${STATE.last_message}`) }, "no JSON object"],
			[{ code: 0, stdout: out(JSON.stringify({ asks_decision: 0.9 })) }, "not a probability"],
		];
		for (const [r, msg] of cases) {
			const err = await provider(fake(r).run)
				.classify(STATE, DEFAULT_BANK)
				.then(
					() => undefined,
					(e: Error) => e.message,
				);
			expect(err).toContain(msg);
			expect(err).not.toContain(STATE.last_message);
		}
	});
});

describe("rules: nothing leaves the machine", () => {
	const run = (last: string) => rulesProvider().classify({ ...STATE, last_message: last }, DEFAULT_BANK);
	test("@ask is looksLikeAsk: a go-phrase escalates", async () => {
		const r = await run("The breaker needs its endpoint; say go and I'll start it.");
		expect(r.answers.asks_decision).toBe(1);
		expect(r.answers.work_finished).toBe(0);
		expect(r.model).toBe("rules");
	});
	test("each question's own regular expressions; @otherwise settles only when no escalate or nudge rule matched", async () => {
		expect((await run("Still waiting on CI; the watch stays on until it lands.")).answers).toMatchObject({
			waiting_external: 1,
			claims_armed_wait: 1,
			work_finished: 0,
		});
		expect((await run("It failed again with the same error; I'm stuck.")).answers.repeated_failure).toBe(1);
		expect((await run("Merged and deployed. Nothing else is owed.")).answers).toEqual({
			...Object.fromEntries(IDS.map((id) => [id, 0])),
			work_finished: 1,
		});
	});
});

describe("what a provider reports about itself is checked before it is kept (review finding)", () => {
	const jevReply = (over: object) => async () =>
		new Response(
			JSON.stringify({
				model: "jev-1.14.0",
				answers: Object.fromEntries(IDS.map((id) => [id, { noul: 0.2 }])),
				usage: { input_tokens: 2000 },
				...over,
			}),
		);
	const jev = (over: object) =>
		jevProvider({ model: "jev-1.14.0", timeoutMs: 1000, key: () => KEY, fetch: jevReply(over) });
	const failure = (p: Promise<unknown>) =>
		p.then(
			() => undefined,
			(e: unknown) => e,
		);

	test("a model id that is not a short token (an echo of the message, an emoji cut in half) is refused with a fixed message", async () => {
		for (const model of [STATE.last_message, `${"x".repeat(79)}🙂`, "a".repeat(81), 7, ["jev"]]) {
			const e = (await failure(jev({ model }).classify(STATE, DEFAULT_BANK))) as ProviderError;
			expect(e).toBeInstanceOf(ProviderError);
			expect(e.message).toBe("Jev reported a model id that is not one");
			// It was billed, so it still says what it cost.
			expect(e.usage).toEqual({ inputTokens: 2000, costUsd: 2000 * 0.042e-6 });
		}
		for (const model of ["jev-1.14.0", "jev-latest", "org/jev:1.14"])
			expect((await jev({ model }).classify(STATE, DEFAULT_BANK)).model).toBe(model);
		expect((await jev({ model: undefined }).classify(STATE, DEFAULT_BANK)).model).toBe("jev-1.14.0");
		expect(MODEL_ID.test(`${"x".repeat(79)}🙂`)).toBe(false);
	});
	test("a billed Jev reply with malformed answers throws with its usage", async () => {
		const e = (await failure(
			jev({ answers: { asks_decision: { noul: 2 } } }).classify(STATE, DEFAULT_BANK),
		)) as ProviderError;
		expect(e).toBeInstanceOf(ProviderError);
		expect(e.usage.inputTokens).toBe(2000);
		const none = (await failure(jev({ answers: null }).classify(STATE, DEFAULT_BANK))) as ProviderError;
		expect(none.message).toBe("Jev's answer has no answers");
		expect(none.usage.inputTokens).toBe(2000);
	});
	test("haiku: an echoed modelUsage key is refused; a malformed reply keeps its cost", async () => {
		const cli =
			(stdout: string): CliRunner =>
			async () => ({ code: 0, stdout });
		const haiku = (stdout: string) =>
			haikuProvider({ command: "claude", model: "haiku", timeoutMs: 1000, run: cli(stdout) });
		const out = (result: string, modelUsage: object) =>
			JSON.stringify({ result, total_cost_usd: 0.001, usage: { input_tokens: 900 }, modelUsage });
		const echoed = (await failure(
			haiku(out(JSON.stringify(half), { [STATE.last_message]: {} })).classify(STATE, DEFAULT_BANK),
		)) as ProviderError;
		expect(echoed.message).toBe("claude reported a model id that is not one");
		expect(echoed.usage).toEqual({ inputTokens: 900, costUsd: 0.001 });
		const bad = (await failure(
			haiku(out("no answers here", { "claude-haiku-5-5": {} })).classify(STATE, DEFAULT_BANK),
		)) as ProviderError;
		expect(bad.usage.costUsd).toBe(0.001);
		expect(
			(
				await haiku(out(JSON.stringify(half), { "claude-haiku-5-5": {}, "claude-sonnet-5-5": {} })).classify(
					STATE,
					DEFAULT_BANK,
				)
			).model,
		).toBe("claude-haiku-5-5");
	});
});

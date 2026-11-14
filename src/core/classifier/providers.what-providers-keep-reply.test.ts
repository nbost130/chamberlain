/** providers, continued: see providers.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { IDS, KEY, STATE } from "../../testing/core-classifier-providers-fixtures.ts";
import { DEFAULT_BANK } from "./bank.ts";
import { haikuProvider, jevProvider } from "./providers.ts";

describe("what the providers keep of a reply's usage and model", () => {
	const answers = Object.fromEntries(IDS.map((id) => [id, { noul: 0.2 }]));
	const jev = (body: unknown) =>
		jevProvider({
			model: "jev-1.14.0",
			timeoutMs: 1000,
			key: () => KEY,
			fetch: async () => new Response(JSON.stringify(body)),
		});
	const haiku = (stdout: string) =>
		haikuProvider({
			command: "claude",
			model: "haiku",
			timeoutMs: 1000,
			run: async () => ({ code: 0, stdout }),
		});
	const reason = (p: Promise<unknown>) =>
		p.then(
			() => "resolved",
			(e: Error) => e.message,
		);
	const usageOf = (r: { inputTokens?: number; costUsd?: number }) => ({
		inputTokens: r.inputTokens,
		costUsd: r.costUsd,
	});
	const cli = (result: string, extra: object = {}) => JSON.stringify({ result, ...extra });

	test("jev: a reply that is JSON but not an object is refused", async () => {
		expect(await reason(jev(null).classify(STATE, DEFAULT_BANK))).toBe("Jev's answer is not an object");
	});
	test("jev: only a finite, non-negative token count is billed; zero counts, and costs nothing", async () => {
		for (const tokens of [-1, "5", null, {}, [3]])
			expect(usageOf(await jev({ answers, usage: { input_tokens: tokens } }).classify(STATE, DEFAULT_BANK))).toEqual({
				inputTokens: undefined,
				costUsd: undefined,
			});
		expect(usageOf(await jev({ answers, usage: { input_tokens: 0 } }).classify(STATE, DEFAULT_BANK))).toEqual({
			inputTokens: 0,
			costUsd: 0,
		});
		expect(usageOf(await jev({ answers, usage: "x" }).classify(STATE, DEFAULT_BANK))).toEqual({
			inputTokens: undefined,
			costUsd: undefined,
		});
	});
	test("haiku: output that is JSON but not an object is refused", async () => {
		for (const stdout of ["null", "5", '"text"'])
			expect(await reason(haiku(stdout).classify(STATE, DEFAULT_BANK))).toBe(
				"claude printed JSON that is not an object",
			);
	});
	test("haiku: the reply's first flat {...} is the answers; text around it is ignored, and one that is not JSON is refused", async () => {
		const flat = Object.fromEntries(IDS.map((id) => [id, 0.3]));
		expect((await haiku(cli(`Sure: ${JSON.stringify(flat)} done`)).classify(STATE, DEFAULT_BANK)).answers).toEqual(
			flat,
		);
		for (const result of ["{oops}", "no braces at all", 5])
			expect(await reason(haiku(cli(result as string)).classify(STATE, DEFAULT_BANK))).toBe(
				"the model's reply holds no JSON object of answers",
			);
	});
	test("haiku: input, cache-written and cache-read tokens add up; anything not a finite non-negative number is zero", async () => {
		const flat = JSON.stringify(Object.fromEntries(IDS.map((id) => [id, 0.3])));
		const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 };
		expect(usageOf(await haiku(cli(flat, { usage, total_cost_usd: 0.5 })).classify(STATE, DEFAULT_BANK))).toEqual({
			inputTokens: 60,
			costUsd: 0.5,
		});
		const junk = { input_tokens: -5, cache_creation_input_tokens: "7", cache_read_input_tokens: 4 };
		expect(usageOf(await haiku(cli(flat, { usage: junk, total_cost_usd: -1 })).classify(STATE, DEFAULT_BANK))).toEqual({
			inputTokens: 4,
			costUsd: undefined,
		});
		for (const extra of [{ usage: "x", total_cost_usd: "1" }, { usage: null }, { total_cost_usd: null }])
			expect(usageOf(await haiku(cli(flat, extra)).classify(STATE, DEFAULT_BANK))).toEqual({
				inputTokens: undefined,
				costUsd: undefined,
			});
		expect(usageOf(await haiku(cli(flat, { total_cost_usd: 0 })).classify(STATE, DEFAULT_BANK)).costUsd).toBe(0);
	});
	test("haiku: the model is the first one reported, else the one asked for", async () => {
		const flat = JSON.stringify(Object.fromEntries(IDS.map((id) => [id, 0.3])));
		for (const modelUsage of [undefined, null, "x", {}])
			expect((await haiku(cli(flat, { modelUsage })).classify(STATE, DEFAULT_BANK)).model).toBe("haiku");
		expect((await haiku(cli(flat, { modelUsage: { "m-1": {}, "m-2": {} } })).classify(STATE, DEFAULT_BANK)).model).toBe(
			"m-1",
		);
	});
});

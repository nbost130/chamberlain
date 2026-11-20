import { describe, expect, test } from "bun:test";
import { PRICE } from "../../testing/overhead-fixtures.ts";
import { parseOverhead } from "./config.ts";
import { parsePrices, priceOf, tokensUsd } from "./prices.ts";

describe("a model name is a key of the table, never a property it inherits", () => {
	const table = parsePrices({ "model-a": PRICE }, "overhead.prices");

	test("names of Object's own properties have no price unless the operator listed them", () => {
		for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "prototype"])
			expect(priceOf(table, name)).toBeUndefined();
		expect(priceOf({}, "constructor")).toBeUndefined();
	});

	test("an operator who does list such a name gets that price, as an own key", () => {
		const odd = parsePrices({ constructor: PRICE }, "p");
		expect(priceOf(odd, "constructor")).toEqual(PRICE);
		const proto = parsePrices(
			JSON.parse('{"__proto__": {"input":1,"cacheWrite5m":1,"cacheWrite1h":1,"cacheRead":1,"output":1}}'),
			"p",
		);
		expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
		expect(priceOf(proto, "__proto__")?.input).toBe(1);
		expect(priceOf(proto, "toString")).toBeUndefined();
	});

	test("a listed model is found with or without the [1m] suffix, and an unlisted one is not", () => {
		expect(priceOf(table, "model-a")).toEqual(PRICE);
		expect(priceOf(table, "model-a[1m]")).toEqual(PRICE);
		expect(priceOf(table, "model-b")).toBeUndefined();
	});

	test("a price that reaches a sum is a finite number, so a priced model never makes a NaN", () => {
		const usd = tokensUsd(
			{ inputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1_000_000 },
			PRICE,
			"1h",
		);
		expect(Number.isFinite(usd)).toBe(true);
		expect(usd).toBeCloseTo(11, 9);
	});

	test("config refuses a non-finite rate, and 'constructor' as the Steward's model with no entry for it", () => {
		expect(() => parseOverhead({ prices: { m: { ...PRICE, input: Number.POSITIVE_INFINITY } } })).toThrow(
			/input must be a/,
		);
		expect(() =>
			parseOverhead({ enabled: true, github: { owners: ["a"] }, prices: { m: PRICE } }, "constructor"),
		).toThrow(/no price for the Steward's model "constructor"/);
	});
});

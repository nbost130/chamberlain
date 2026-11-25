/**
 * The model price table the overhead report prices tokens with: the operator's `overhead.prices` in config.json, and nothing else. Chamberlain
 * ships no rates, because a rate is a fact about a vendor's current price list and goes stale; the operator copies the rates they pay (see
 * docs/CONFIGURATION.md, "overhead") and keeps them current. A model with no entry has no price, so its spend is reported as unavailable,
 * never as a guess or as zero.
 *
 * USD per million tokens, the four usage fields of the API's `usage` object. The usage rows (`steward_wake_usage`) keep ONE cache-creation
 * column, with no split between the five-minute and one-hour cache writes, so the writer's TTL is a setting (`overhead.cacheWrite`).
 */
import { num, type Obj, object } from "../config/config-fields.ts";
import type { WakeUsage } from "../store/store-records.ts";

export type Price = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };
export type PriceTable = Record<string, Price>;
export type CacheWrite = "5m" | "1h";

const RATES = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"] as const;

/** Pure: the table as the operator wrote it, every model with all five rates, each zero or more. Left out: an empty table. */
export function parsePrices(raw: unknown, where: string): PriceTable {
	if (raw === undefined || raw === null) return {};
	const table = object(raw, where, Object.keys(raw as Obj));
	const out: PriceTable = {};
	for (const [model, row] of Object.entries(table)) {
		if (!model.trim()) throw Error(`${where}: a model name cannot be empty`);
		const o = object(row, `${where}.${model}`, RATES);
		for (const r of RATES) if (o[r] === undefined) throw Error(`${where}.${model}: ${r} is required`);
		const rate = (k: (typeof RATES)[number]) => num(o, k, `${where}.${model}`, { d: 0, whole: false, zeroOk: true });
		// defineProperty, not assignment: a model named "__proto__" must become a key, never the table's prototype.
		Object.defineProperty(out, model, {
			enumerable: true,
			configurable: true,
			writable: true,
			value: {
				input: rate("input"),
				cacheWrite5m: rate("cacheWrite5m"),
				cacheWrite1h: rate("cacheWrite1h"),
				cacheRead: rate("cacheRead"),
				output: rate("output"),
			},
		});
	}
	return out;
}

/** The price of a model id (a `[1m]` suffix accepted), or undefined for a model the table does not list. Own keys only: "constructor" is not a price. */
export function priceOf(table: PriceTable, model: string): Price | undefined {
	const key = model.trim().replace(/\[[^\]]*\]$/, "");
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

export type TokenCounts = Pick<
	WakeUsage,
	"inputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "outputTokens"
>;

/** What the four usage fields cost at a price, in USD. */
export function tokensUsd(t: TokenCounts, p: Price, cacheWrite: CacheWrite): number {
	const { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens } = t;
	if (
		inputTokens === undefined ||
		cacheReadInputTokens === undefined ||
		cacheCreationInputTokens === undefined ||
		outputTokens === undefined
	)
		return Number.NaN;
	const write = cacheWrite === "1h" ? p.cacheWrite1h : p.cacheWrite5m;
	return (
		(inputTokens * p.input +
			cacheReadInputTokens * p.cacheRead +
			cacheCreationInputTokens * write +
			outputTokens * p.output) /
		1_000_000
	);
}

export function recordedTurnUsd(row: WakeUsage, prices: PriceTable, cacheWrite: CacheWrite): number | undefined {
	if (!row.model || row.tokensIncomplete) return undefined;
	const price = priceOf(prices, row.model);
	const usd = price && tokensUsd(row, price, cacheWrite);
	return usd !== undefined && Number.isFinite(usd) ? usd : undefined;
}

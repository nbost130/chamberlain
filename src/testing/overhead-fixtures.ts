/** Fixtures for the overhead monitor's tests: round-number prices and tokens, so every expected dollar figure can be checked by eye. All names are made up. */
import { type OverheadConfig, parseOverhead } from "../core/overhead/config.ts";
import type { MergedPr } from "../core/overhead/metrics.ts";
import type { Price } from "../core/overhead/prices.ts";
import type { WakeUsage } from "../core/store/store-records.ts";

export const NOW = Date.parse("2026-11-18T12:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MODEL = "test-model";
/** $1 in, $10 out, $0.50 cache read, $2 and $3 cache write, per million tokens. */
export const PRICE: Price = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 0.5, output: 10 };

/** A parsed config that counts PRs of one made-up owner and prices one made-up model; `section` adds to or replaces keys of the section. */
export function cfgWith(section: Record<string, unknown> = {}): OverheadConfig {
	return parseOverhead({ github: { owners: ["acme"] }, prices: { [MODEL]: PRICE }, ...section }, MODEL);
}

let seq = 0;
/**
 * One Steward turn started `hoursAgo` hours before NOW that cost `usd` dollars: its output tokens are chosen to price at that, at $10 per
 * million. `tools` is the tool-call count (undefined: not measured). `kind` defaults to a wake.
 */
export function wake(o: { hoursAgo: number; usd?: number; tools?: number; kind?: string; now?: number }): WakeUsage {
	const startedAt = (o.now ?? NOW) - o.hoursAgo * HOUR;
	seq++;
	return {
		session: "s1",
		wakeKey: `w${seq}`,
		kind: o.kind ?? "turn_ended",
		startedAt,
		endedAt: startedAt + 1000,
		requests: 1,
		model: MODEL,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: Math.round(((o.usd ?? 1) / PRICE.output) * 1_000_000),
		compactions: 0,
		...(o.tools !== undefined ? { toolCalls: o.tools } : {}),
	};
}

export const pr = (repo: string, number: number, hoursAgo: number, title = `change ${number}`): MergedPr => ({
	repo,
	number,
	mergedAt: NOW - hoursAgo * HOUR,
	title,
});

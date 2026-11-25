/** Missing or non-finite inputs never cross a limit: a missing baseline is unavailable, never $0, and NaN or Infinity is never a metric. */
import { describe, expect, test } from "bun:test";
import { cfgWith, DAY, NOW, PRICE, wake } from "../../testing/overhead-fixtures.ts";
import { costLimit, crossings, type WindowMetrics, windowMetrics } from "./metrics.ts";

const usage = [wake({ hoursAgo: 2, usd: 50, tools: 1 })];
const window = (o: { from?: number; to?: number; prs?: number } = {}) =>
	windowMetrics({
		usage,
		from: o.from ?? NOW - DAY,
		to: o.to ?? NOW,
		prices: { "test-model": PRICE },
		cacheWrite: "1h",
		classifierUsd: 0,
		...(o.prs === undefined ? {} : { prs: o.prs }),
	});

describe("a missing baseline never triggers", () => {
	const cfg = cfgWith({ triggers: { costPerPr: { mode: "trigger", baselineMultiplier: 1.5 } } });
	const today = window({ prs: 5 });

	test("a baseline period with no usage rows has no cost per PR, so no limit, so no crossing, however many PRs it had", () => {
		const baseline = window({ from: NOW - 8 * DAY, to: NOW - DAY, prs: 40 });
		expect(baseline.turns).toBe(0);
		expect(baseline.costPerPr).toBeUndefined();
		expect(costLimit(cfg.triggers.costPerPr, baseline)).toBeUndefined();
		expect(crossings({ day: today, baseline, cfg })).toEqual([]);
	});

	test("a baseline whose cost per PR is zero, or not a number, gives no limit either: $0 would let any PR cross", () => {
		for (const costPerPr of [0, Number.NaN, Number.POSITIVE_INFINITY, -1])
			expect(costLimit(cfg.triggers.costPerPr, { costPerPr } as WindowMetrics)).toBeUndefined();
		expect(crossings({ day: today, baseline: { costPerPr: 0 } as WindowMetrics, cfg })).toEqual([]);
	});

	test("a fixed limit still stands when the baseline is missing", () => {
		const fixed = cfgWith({ triggers: { costPerPr: { mode: "trigger", baselineMultiplier: 1.5, fixedUsd: 5 } } });
		expect(crossings({ day: today, baseline: {} as WindowMetrics, cfg: fixed })).toHaveLength(1);
	});
});

describe("a value that is not a finite number never triggers", () => {
	const all = cfgWith({
		fleet: { source: "lifeos" },
		triggers: {
			costPerPr: { mode: "trigger", fixedUsd: 1, zeroPrFloorUsd: 1 },
			noopRate: { mode: "trigger", threshold: 0.1, minWakes: 1 },
			spendShare: { mode: "trigger", threshold: 0.1 },
		},
	});

	test("NaN and Infinity in any metric cross nothing", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const d = { prs: 5, basisUsd: bad, costPerPr: bad, noopRate: bad, measured: 99 } as WindowMetrics;
			expect(crossings({ day: d, baseline: { costPerPr: 1 } as WindowMetrics, spendShare: bad, cfg: all })).toEqual([]);
			const zero = { prs: 0, basisUsd: bad } as WindowMetrics;
			expect(crossings({ day: zero, baseline: {} as WindowMetrics, cfg: all })).toEqual([]);
		}
	});
});

import { describe, expect, test } from "bun:test";
import { cfgWith, DAY, MODEL, NOW, PRICE, pr, wake } from "../../testing/overhead-fixtures.ts";
import { costLimit, countedPrs, countMerged, crossings, type WindowMetrics, windowMetrics } from "./metrics.ts";
import { tokensUsd } from "./prices.ts";

const span = { from: NOW - DAY, to: NOW };
const github = { rollupTitle: "^Rollup of \\d+ pull requests?", countRollups: false, excludeRepos: [] as string[] };

const day = (o: Partial<Parameters<typeof windowMetrics>[0]> & { usage: ReturnType<typeof wake>[] }) =>
	windowMetrics({ from: NOW - DAY, to: NOW, prices: { [MODEL]: PRICE }, cacheWrite: "1h", classifierUsd: 0, ...o });

describe("pricing", () => {
	test("unpriced legacy rows leave a labeled subtotal and no full-window cost basis", () => {
		const priced = wake({ hoursAgo: 1, usd: 10, tools: 1 });
		const legacy = { ...wake({ hoursAgo: 2, tools: 1 }), source: "transcript" as const, model: undefined };
		const report = day({ usage: [priced, legacy], prs: 1 });
		expect(report).toMatchObject({ stewardUsd: 10, unpricedTurns: 1 });
		expect(report.basisUsd).toBeUndefined();
		expect(report.costPerPr).toBeUndefined();
	});
	test("each turn uses its own recorded model and an incomplete window has unavailable spend", () => {
		const first = wake({ hoursAgo: 1, usd: 10 });
		const second = { ...wake({ hoursAgo: 2, usd: 10 }), model: "second" };
		const prices = { [MODEL]: PRICE, second: { ...PRICE, output: 20 } };
		expect(day({ usage: [first, second], prices }).stewardUsd).toBe(30);
		for (const row of [
			{ ...second, model: undefined },
			{ ...second, tokensIncomplete: true },
			{ ...second, outputTokens: undefined },
		])
			expect(day({ usage: [first, row], prices }).stewardUsd).toBeUndefined();
	});
	test("the four usage fields are priced at the configured rates, per million tokens", () => {
		const t = {
			inputTokens: 1_000_000,
			cacheReadInputTokens: 2_000_000,
			cacheCreationInputTokens: 1_000_000,
			outputTokens: 1_000_000,
		};
		expect(tokensUsd(t, PRICE, "1h")).toBeCloseTo(1 + 1 + 3 + 10, 9);
		expect(tokensUsd(t, PRICE, "5m")).toBeCloseTo(1 + 1 + 2 + 10, 9);
	});
});

describe("window metrics", () => {
	const usage = [
		wake({ hoursAgo: 2, usd: 10, tools: 3 }),
		wake({ hoursAgo: 3, usd: 6, tools: 0 }),
		wake({ hoursAgo: 4, usd: 4, tools: 0 }),
		wake({ hoursAgo: 5, usd: 5, tools: 1 }),
		wake({ hoursAgo: 6, usd: 5, tools: undefined }), // before tool counts: not measured
		wake({ hoursAgo: 7, usd: 20, kind: "message", tools: 9 }), // a turn, not a wake: costs, is not a wake
		wake({ hoursAgo: 30, usd: 100, tools: 0 }), // outside the window
	];

	test("spend sums every turn in the window, priced; wakes, no-ops and useful wakes are counted over measured wakes", () => {
		const m = day({ usage, prs: 5, classifierUsd: 2 });
		expect(m.stewardUsd).toBeCloseTo(50, 6);
		expect(m.classifierUsd).toBe(2);
		expect(m.basisUsd).toBeCloseTo(52, 6);
		expect(m.wakes).toBe(5);
		expect(m.measured).toBe(4);
		expect(m.noop).toBe(2);
		expect(m.useful).toBe(2);
		expect(m.noopRate).toBeCloseTo(0.5, 9);
	});

	test("cost per merged PR is basis spend / PRs; cost per useful wake is Steward spend / useful wakes", () => {
		const m = day({ usage, prs: 4, classifierUsd: 2 });
		expect(m.costPerPr).toBeCloseTo(13, 6);
		expect(m.costPerUsefulWake).toBeCloseTo(25, 6);
	});

	test("zero PRs never divides: no cost per PR, and the count stays 0", () => {
		const m = day({ usage, prs: 0 });
		expect(m.prs).toBe(0);
		expect(m.costPerPr).toBeUndefined();
		expect(Number.isNaN(m.basisUsd)).toBe(false);
	});

	test("PRs not counted (not configured or unreadable) leave the PR numbers undefined, not 0", () => {
		const m = day({ usage });
		expect(m.prs).toBeUndefined();
		expect(m.costPerPr).toBeUndefined();
		expect(m.noopRate).toBeCloseTo(0.5, 9);
	});

	test("no price for the model makes the spend unavailable, never zero, and leaves the no-op rate alone", () => {
		const m = windowMetrics({ usage, ...span, cacheWrite: "1h", classifierUsd: 0, prs: 3 });
		expect(m.stewardUsd).toBeUndefined();
		expect(m.basisUsd).toBeUndefined();
		expect(m.costPerPr).toBeUndefined();
		expect(m.noopRate).toBeCloseTo(0.5, 9);
	});

	test("a window with no usage rows was not measured: counts are zero and every spend figure is unavailable, never $0", () => {
		const m = day({ usage: [], prs: 2 });
		expect([m.turns, m.wakes, m.measured, m.noop, m.useful]).toEqual([0, 0, 0, 0, 0]);
		expect(m.noopRate).toBeUndefined();
		expect(m.costPerUsefulWake).toBeUndefined();
		expect(m.stewardUsd).toBeUndefined();
		expect(m.basisUsd).toBeUndefined();
		expect(m.costPerPr).toBeUndefined();
	});

	test("a spend that is not a finite number is unavailable", () => {
		const bad = { ...wake({ hoursAgo: 1, usd: 1, tools: 1 }), outputTokens: Number.NaN };
		const m = day({ usage: [bad], prs: 2 });
		expect(m.stewardUsd).toBeUndefined();
		expect(m.costPerPr).toBeUndefined();
	});
});

describe("counting merged PRs", () => {
	const prs = [
		pr("acme/app", 1, 2),
		pr("acme/app", 2, 3),
		pr("acme/app", 2, 3), // the same PR read twice (an owner and a repo scope)
		pr("acme/app", 9, 4, "Rollup of 2 pull requests"),
		pr("acme/docs", 5, 5),
		pr("acme/app", 3, 30), // outside the window
	];

	test("each PR counts once, a rollup PR does not, repos are told apart", () => {
		expect(countedPrs(prs, span, github)).toEqual(["acme/app#1", "acme/app#2", "acme/docs#5"]);
		expect(countMerged(prs, span, github)).toBe(3);
	});

	test("a rollup's own bundled PRs are the ones counted: 3 constituents plus the rollup is 3, not 4", () => {
		const rolled = [
			pr("acme/app", 11, 1),
			pr("acme/app", 12, 1),
			pr("acme/app", 13, 1),
			pr("acme/app", 20, 1, "Rollup of 3 pull requests"),
		];
		expect(countMerged(rolled, span, github)).toBe(3);
	});

	test("with countRollups on, the rollup PR counts like any other", () => {
		expect(countMerged(prs, span, { ...github, countRollups: true })).toBe(4);
	});

	test("the rollup pattern is the operator's", () => {
		const batch = [pr("a/b", 1, 1, "Batch: 3 PRs"), pr("a/b", 2, 1)];
		expect(countMerged(batch, span, { ...github, rollupTitle: "^Batch" })).toBe(1);
		expect(countMerged(batch, span, github)).toBe(2);
	});

	test("excluded repos are left out, compared without regard to case", () => {
		expect(countedPrs(prs, span, { ...github, excludeRepos: ["ACME/docs"] })).toEqual(["acme/app#1", "acme/app#2"]);
	});

	test("the window is [from, to): a PR merged exactly at `to` is outside, at `from` inside", () => {
		const edge = [
			{ repo: "a/b", number: 1, mergedAt: span.to, title: "x" },
			{ repo: "a/b", number: 2, mergedAt: span.from, title: "y" },
		];
		expect(countedPrs(edge, span, github)).toEqual(["a/b#2"]);
	});
});

describe("the cost limit", () => {
	const baseline = { costPerPr: 4 } as WindowMetrics;
	test("a multiplier is measured against the baseline; a fixed amount stands alone; both give the lower", () => {
		expect(costLimit({ mode: "trigger", baselineMultiplier: 1.5 }, baseline)).toBe(6);
		expect(costLimit({ mode: "trigger", fixedUsd: 5 }, baseline)).toBe(5);
		expect(costLimit({ mode: "trigger", baselineMultiplier: 1.5, fixedUsd: 5 }, baseline)).toBe(5);
		expect(costLimit({ mode: "trigger", baselineMultiplier: 1.5, fixedUsd: 9 }, baseline)).toBe(6);
	});

	test("a multiplier with no baseline cost per PR has no limit; the fixed amount still does", () => {
		const none = {} as WindowMetrics;
		expect(costLimit({ mode: "trigger", baselineMultiplier: 1.5 }, none)).toBeUndefined();
		expect(costLimit({ mode: "trigger", baselineMultiplier: 1.5, fixedUsd: 5 }, none)).toBe(5);
		expect(costLimit({ mode: "trigger" }, baseline)).toBeUndefined();
	});
});

describe("crossings: each limit fires and does not fire, per mode", () => {
	const base = { costPerPr: 4, prs: 10 } as WindowMetrics;
	const trig = (section: Record<string, unknown>) => cfgWith({ triggers: section });
	const noops = (n: number, of: number): WindowMetrics =>
		({ noop: n, measured: of, noopRate: n / of }) as WindowMetrics;

	describe("cost per merged PR", () => {
		const cfg = trig({ costPerPr: { mode: "trigger", baselineMultiplier: 1.5 } });
		const dayAt = (costPerPr: number, extra: Partial<WindowMetrics> = {}) =>
			({ prs: 10, basisUsd: costPerPr * 10, costPerPr, ...extra }) as WindowMetrics;

		test("fires above the multiplier x baseline, naming the figures", () => {
			const c = crossings({ day: dayAt(6.5), baseline: base, cfg });
			expect(c).toHaveLength(1);
			expect(c[0]).toMatchObject({ metric: "costPerPr", threshold: 6, value: 6.5 });
			expect(c[0]?.detail).toContain("$6.50 per merged PR");
		});

		test("does not fire at or below it", () => {
			expect(crossings({ day: dayAt(6), baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: dayAt(3), baseline: base, cfg })).toEqual([]);
		});

		test("a fixed dollar limit fires on its own, with no baseline at all", () => {
			const fixed = trig({ costPerPr: { mode: "trigger", fixedUsd: 5 } });
			expect(crossings({ day: dayAt(5.5), baseline: {} as WindowMetrics, cfg: fixed })).toHaveLength(1);
			expect(crossings({ day: dayAt(4.5), baseline: {} as WindowMetrics, cfg: fixed })).toEqual([]);
		});

		test("report mode never fires, however high", () => {
			const report = trig({ costPerPr: { mode: "report", baselineMultiplier: 1.5, fixedUsd: 1 } });
			expect(crossings({ day: dayAt(500), baseline: base, cfg: report })).toEqual([]);
		});

		test("fails closed: no PR count, no price, or no baseline for a multiplier crosses nothing", () => {
			expect(crossings({ day: { basisUsd: 999 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: { prs: 3 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: dayAt(99), baseline: {} as WindowMetrics, cfg })).toEqual([]);
		});
	});

	describe("zero merged PRs", () => {
		const cfg = trig({ costPerPr: { mode: "trigger", baselineMultiplier: 1.5, zeroPrFloorUsd: 5 } });

		test("spend above the floor with no PR merged fires; at or below it does not; never divides", () => {
			const hot = crossings({ day: { prs: 0, basisUsd: 7 } as WindowMetrics, baseline: base, cfg });
			expect(hot).toHaveLength(1);
			expect(hot[0]).toMatchObject({ metric: "costPerPr", value: 7, threshold: 5 });
			expect(hot[0]?.detail).toContain("no PR merged");
			expect(crossings({ day: { prs: 0, basisUsd: 5 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: { prs: 0, basisUsd: 1 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
		});

		test("with no floor configured, zero PRs crosses nothing", () => {
			const noFloor = trig({ costPerPr: { mode: "trigger", baselineMultiplier: 1.5 } });
			expect(crossings({ day: { prs: 0, basisUsd: 500 } as WindowMetrics, baseline: base, cfg: noFloor })).toEqual([]);
		});

		test("an unknown PR count with high spend crosses nothing", () => {
			expect(crossings({ day: { basisUsd: 500 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
		});
	});

	describe("no-op wake rate", () => {
		const cfg = trig({ noopRate: { mode: "trigger", threshold: 0.1, minWakes: 20 } });

		test("fires above the threshold on enough wakes", () => {
			const c = crossings({ day: noops(6, 40), baseline: base, cfg });
			expect(c).toHaveLength(1);
			expect(c[0]).toMatchObject({ metric: "noopRate", threshold: 0.1, value: 0.15 });
		});

		test("does not fire at the threshold or below", () => {
			expect(crossings({ day: noops(4, 40), baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: noops(2, 40), baseline: base, cfg })).toEqual([]);
		});

		test("does not fire on too few measured wakes, however bad the rate", () => {
			expect(crossings({ day: noops(10, 10), baseline: base, cfg })).toEqual([]);
			expect(crossings({ day: noops(1, 19), baseline: base, cfg })).toEqual([]);
		});

		test("report mode never fires, and no measured wakes crosses nothing", () => {
			const report = trig({ noopRate: { mode: "report", threshold: 0.1 } });
			expect(crossings({ day: noops(40, 40), baseline: base, cfg: report })).toEqual([]);
			expect(crossings({ day: { measured: 0 } as WindowMetrics, baseline: base, cfg })).toEqual([]);
		});
	});

	describe("spend share", () => {
		const withFleet = cfgWith({
			fleet: { source: "lifeos" },
			triggers: { spendShare: { mode: "trigger", threshold: 0.3 } },
		});

		test("fires above its threshold only when the operator made it a trigger", () => {
			expect(crossings({ day: base, baseline: base, spendShare: 0.4, cfg: withFleet })).toHaveLength(1);
			expect(crossings({ day: base, baseline: base, spendShare: 0.3, cfg: withFleet })).toEqual([]);
			expect(crossings({ day: base, baseline: base, spendShare: 0.9, cfg: cfgWith() })).toEqual([]);
		});

		test("fails closed: an unavailable share crosses nothing", () => {
			expect(crossings({ day: base, baseline: base, cfg: withFleet })).toEqual([]);
		});
	});

	test("with nothing configured to trigger, nothing crosses", () => {
		expect(
			crossings({
				day: { prs: 1, basisUsd: 1e6, costPerPr: 1e6, noopRate: 1, measured: 99 } as WindowMetrics,
				baseline: base,
				spendShare: 1,
				cfg: cfgWith(),
			}),
		).toEqual([]);
	});
});

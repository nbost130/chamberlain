import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, MODEL, NOW, wake } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { collect } from "./collect.ts";
import { formatOverhead, summarize, summaryLine } from "./format.ts";

const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** A GhRead that reports these PRs (`[repo, number, hoursAgo, title?]`) for whatever it is asked, or throws. */
const ghWith = (prs: [string, number, number, string?][] | Error) => async () => {
	if (prs instanceof Error) throw prs;
	return {
		total: prs.length,
		incomplete: false,
		items: prs.map(([repo, n, h, t]) => ({
			r: `https://api.github.com/repos/${repo}`,
			n,
			m: iso(h),
			t: t ?? `PR ${n}`,
		})),
	};
};
const prsAt = (count: number, firstHour: number, from = 1): [string, number, number][] =>
	Array.from({ length: count }, (_, i) => ["acme/app", from + i, firstHour + i * 0.1]);

function storeWith(rows: ReturnType<typeof wake>[]) {
	const s = memStore();
	s.usage.upsert(rows);
	return s;
}
const answer = (rows: string[]) => ["k,name,micros", ...rows].join("\n");
const run = (cfg: ReturnType<typeof cfgWith>, store: ReturnType<typeof memStore>, o: Record<string, unknown> = {}) =>
	collect({ store, cfg, model: MODEL, gh: ghWith([]), now: NOW, ...o });

/** 24 h: $90 over 10 wakes; the 7 days before: $70 over 7 wakes. */
const rows = () => [
	...Array.from({ length: 10 }, (_, i) => wake({ hoursAgo: 1 + i, usd: 9, tools: i < 8 ? 1 : 0 })),
	...Array.from({ length: 7 }, (_, i) => wake({ hoursAgo: 30 + i * 20, usd: 10, tools: 1 })),
];

describe("not configured is not unavailable", () => {
	test("with no owners or repos the PR numbers are 'not configured', reported and never triggered", async () => {
		const cfg = cfgWith({ github: {}, triggers: { noopRate: { mode: "report" } } });
		const r = await run(cfg, storeWith(rows()));
		expect(r.prStatus).toBe("not-configured");
		expect(r.day.prs).toBeUndefined();
		expect(r.day.costPerPr).toBeUndefined();
		expect(r.notConfigured.join(" ")).toContain("overhead.github.owners or overhead.github.repos");
		expect(r.unavailable).toEqual([]);
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("cost per merged PR   24 h not configured");
		expect(summaryLine(summarize(r))).toContain("not configured/PR 24 h");
		expect(summaryLine(summarize(r))).toContain("not configured PRs merged");
	});

	test("a fleet source of off is 'not configured' too, and the share is not shown", async () => {
		const r = await run(cfgWith(), storeWith(rows()));
		expect(r.fleetStatus).toBe("not-configured");
		expect(r.spendShare).toBeUndefined();
		expect(r.notConfigured.some((n) => n.startsWith("fleet spend"))).toBe(true);
		expect(summaryLine(summarize(r))).toContain("share not configured");
	});
});

describe("the numbers", () => {
	const cfg = cfgWith({ triggers: { costPerPr: { mode: "trigger", baselineMultiplier: 1.5 } } });

	test("cost per merged PR over the window and the baseline period, and the limit that comes of the baseline", async () => {
		const r = await run(cfg, storeWith(rows()), { gh: ghWith([...prsAt(10, 1), ...prsAt(14, 30, 100)]) });
		expect(r.prStatus).toBe("ok");
		expect(r.day.prs).toBe(10);
		expect(r.day.basisUsd).toBeCloseTo(90, 5);
		expect(r.day.costPerPr).toBeCloseTo(9, 5);
		expect(r.baseline.prs).toBe(14);
		expect(r.baseline.costPerPr).toBeCloseTo(5, 5);
		expect(r.limits.costPerPr.limitUsd).toBeCloseTo(7.5, 5);
	});

	test("a crossing is found when the window costs more per PR than the limit", async () => {
		const r = await run(cfg, storeWith(rows()), { gh: ghWith([...prsAt(10, 1), ...prsAt(14, 30, 100)]) });
		expect(r.crossings).toHaveLength(1);
		expect(r.crossings[0]?.detail).toContain("$9.00 per merged PR");
		expect(formatOverhead(r)).toContain("CROSSED:");
		expect(formatOverhead(r)).toContain("triggers, limit $7.50");
	});

	test("a window that stays under its limit does not cross", async () => {
		const r = await run(cfg, storeWith(rows()), { gh: ghWith([...prsAt(30, 1), ...prsAt(14, 30, 100)]) });
		expect(r.day.costPerPr).toBeCloseTo(3, 5);
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("No limit crossed.");
	});

	test("rollups: the rollup PR is not counted, its bundled PRs are", async () => {
		const bundled = [
			...prsAt(3, 1),
			["acme/app", 99, 1, "Rollup of 3 pull requests"] as [string, number, number, string],
		];
		const r = await run(cfg, storeWith(rows()), { gh: ghWith(bundled) });
		expect(r.day.prs).toBe(3);
		const counted = await run(cfgWith({ github: { owners: ["acme"], countRollups: true } }), storeWith(rows()), {
			gh: ghWith(bundled),
		});
		expect(counted.day.prs).toBe(4);
	});

	test("excluded repos are not counted", async () => {
		const r = await run(cfgWith({ github: { owners: ["acme"], excludeRepos: ["acme/docs"] } }), storeWith(rows()), {
			gh: ghWith([...prsAt(3, 1), ["acme/docs", 7, 2]]),
		});
		expect(r.day.prs).toBe(3);
		expect(r.prList).toEqual(["acme/app#1", "acme/app#2", "acme/app#3"]);
	});

	test("the window and baseline lengths are the operator's", async () => {
		const r = await run(cfgWith({ windowHours: 6, baselineDays: 2 }), storeWith(rows()), { gh: ghWith(prsAt(2, 1)) });
		expect(r.windowMs).toBe(6 * HOUR);
		expect(r.baselineMs).toBe(48 * HOUR);
		expect(r.day.wakes).toBe(6);
		expect(formatOverhead(r)).toContain("rolling 6 h");
	});

	test("a window with no usage rows was not measured: it shows 'no usage data', never a $0.00 cost per PR", async () => {
		const r = await run(cfgWith(), storeWith(rows().slice(0, 10)), { gh: ghWith(prsAt(5, 60)) });
		const gap = r.trend[0];
		expect(gap?.turns).toBe(0);
		expect(gap?.prs).toBe(5);
		expect(formatOverhead(r)).toMatch(/\d\d-\d\d +5 +no usage data/);
	});

	test("a zero-PR window crosses only above the floor", async () => {
		const zero = cfgWith({ triggers: { costPerPr: { mode: "trigger", zeroPrFloorUsd: 5 } } });
		expect((await run(zero, storeWith(rows()), { gh: ghWith([]) })).crossings).toHaveLength(1);
		expect(
			(await run(zero, storeWith([wake({ hoursAgo: 1, usd: 4, tools: 1 })]), { gh: ghWith([]) })).crossings,
		).toEqual([]);
	});
});

describe("fails closed", () => {
	test("GitHub unreadable: the PR numbers are unavailable, the cost trigger cannot fire, the no-op trigger still can", async () => {
		const cfg = cfgWith({
			triggers: {
				costPerPr: { mode: "trigger", fixedUsd: 1 },
				noopRate: { mode: "trigger", threshold: 0.1, minWakes: 5 },
			},
		});
		const r = await run(cfg, storeWith(rows()), { gh: ghWith(Error("GitHub read failed: down")) });
		expect(r.prStatus).toBe("unavailable");
		expect(r.unavailable.join(" ")).toContain("merged PRs: unavailable (other)");
		expect(r.unavailable.join(" ")).not.toContain("GitHub read failed");
		expect(r.day.costPerPr).toBeUndefined();
		expect(r.crossings.map((c) => c.metric)).toEqual(["noopRate"]);
	});

	test("the fleet total unavailable: the share is unavailable and a share trigger cannot fire, however it is set", async () => {
		const cfg = cfgWith({
			fleet: { source: "lifeos" },
			triggers: { spendShare: { mode: "trigger", threshold: 0.01 } },
		});
		const r = await run(cfg, storeWith(rows()), {
			query: async () => {
				throw Error("LifeOS query failed: no route");
			},
		});
		expect(r.fleetStatus).toBe("unavailable");
		expect(r.spendShare).toBeUndefined();
		expect(r.unavailable.join(" ")).toContain("fleet spend: unavailable (other)");
		expect(r.unavailable.join(" ")).not.toContain("no route");
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("UNAVAILABLE: fleet spend");
	});

	test("the Steward's model has no price: the spend is unavailable, not zero, and no cost trigger fires", async () => {
		const cfg = cfgWith({ triggers: { costPerPr: { mode: "trigger", fixedUsd: 0.01 } } });
		const r = await run(cfg, storeWith(rows().map((r) => ({ ...r, model: "other-model" }))), {
			gh: ghWith(prsAt(5, 1)),
		});
		expect(r.day.stewardUsd).toBeUndefined();
		expect(r.unavailable.join(" ")).toContain("missing turn usage, recorded model or price");
		expect(r.crossings).toEqual([]);
	});

	test("a model named like an Object property has no price: the spend is unavailable, never NaN", async () => {
		const cfg = cfgWith({ triggers: { costPerPr: { mode: "trigger", fixedUsd: 0.01 } } });
		for (const model of ["constructor", "toString", "__proto__"]) {
			const r = await run(cfg, storeWith(rows().map((r) => ({ ...r, model }))), { gh: ghWith(prsAt(5, 1)) });
			expect(r.day.stewardUsd).toBeUndefined();
			expect(Number.isNaN(r.day.basisUsd)).toBe(false);
			expect(r.crossings).toEqual([]);
		}
	});

	test("no current selection still prices turns with recorded models", async () => {
		const { model: _drop, ...deps } = { model: MODEL };
		const r = await collect({ store: storeWith(rows()), cfg: cfgWith(), gh: ghWith([]), now: NOW, ...deps });
		expect(r.day.stewardUsd).toBe(90);
	});
});

describe("the fleet share", () => {
	const cfg = cfgWith({
		fleet: { source: "lifeos", hosts: ["h1", "h2"] },
		triggers: { spendShare: { mode: "trigger", threshold: 0.3 } },
	});

	test("partial legacy spend is labeled in both reports and cannot feed fleet ratios", async () => {
		const r = await run(
			cfg,
			storeWith([wake({ hoursAgo: 1, usd: 10 }), { ...wake({ hoursAgo: 2 }), model: undefined }]),
			{ query: async () => answer(["fleet,h1,50000000", "fleet,h2,50000000"]) },
		);
		expect(formatOverhead(r)).toContain("$10.00 (1 unpriced)");
		expect(summaryLine(summarize(r))).toContain("$10.00 (1 unpriced)");
		expect(r.spendShare).toBeUndefined();
		expect(r.stewardShare).toBeUndefined();
	});

	test("spend is priced but fleet ratios are unavailable when its telemetry omits a metered turn", async () => {
		const projection = { ...wake({ hoursAgo: 1, usd: 12 }), source: "turn record" as const };
		const r = await run(cfg, storeWith([projection]), {
			query: async () => answer(["fleet,h1,50000000", "fleet,h2,50000000"]),
		});
		expect(r.day.stewardUsd).toBe(12);
		expect(r.spendShare).toBeUndefined();
		expect(r.stewardShare).toBeUndefined();
		expect(r.unavailable.join(" ")).toContain("fleet telemetry does not cover every metered turn");
	});

	test("is (Steward + the butlers and investigators in Chamberlain's records) / fleet, a share over the window, with a trigger the operator set", async () => {
		const query = async (_c: string, a: string[]) =>
			(a[2] ?? "").includes("'mthread'")
				? answer(["mthread,mac b1,6000000", "mthread,mac inv,4000000"])
				: answer(["fleet,h1,200000000", "fleet,h2,100000000"]);
		const r = await run(cfg, storeWith(rows()), { query, own: { butlers: ["b1"], investigators: ["inv"] } });
		expect(r.fleetStatus).toBe("ok");
		expect(r.spendShare).toBeCloseTo((90 + 6 + 4) / 300, 6);
		expect(r.crossings).toHaveLength(1);
		expect(r.crossings[0]).toMatchObject({ metric: "spendShare" });
		expect(formatOverhead(r)).toContain("investigators $4.00");
	});

	test("a configured host with no rows is named and makes the share unavailable: a short total is never a smaller denominator that can trigger", async () => {
		const r = await run(cfg, storeWith(rows()), { query: async () => answer(["fleet,h1,400000000"]) });
		expect(r.spendShare).toBeUndefined();
		expect(r.fleetStatus).toBe("unavailable");
		expect(r.unavailable.join(" ")).toContain("no fleet rows for h2");
		expect(r.crossings).toEqual([]);
		expect(summaryLine(summarize(r))).toContain("share unavailable");
	});
});

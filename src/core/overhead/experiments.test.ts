/** Experiments (eval runs) are in no overhead figure: not the fleet total, not a Chamberlain-caused slice, not either share. */
import { describe, expect, test } from "bun:test";
import { cfgWith, MODEL, NOW, wake } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { collect } from "./collect.ts";
import { parseOverhead } from "./config.ts";
import { fleetSql, parseFleet } from "./fleet-spend.ts";
import { formatOverhead, summarize, summaryLine } from "./format.ts";

const cfg = cfgWith({
	excludeProjects: ["lab"],
	excludeLabels: ["assay"],
	fleet: { source: "lifeos", hosts: ["h1", "h2"] },
	triggers: { spendShare: { mode: "report", threshold: 0.2 } },
});
const csv = (...rows: string[]) => ["k,name,micros", ...rows].join("\n");
/** $90 of Steward spend in the window. */
const stewardDay = () => Array.from({ length: 10 }, (_, i) => wake({ hoursAgo: 1 + i, usd: 9, tools: 1 }));

describe("the exclusion is configuration, empty by default", () => {
	test("nothing is excluded unless the operator says so, and the query then has no join to sessions for the total", () => {
		const none = parseOverhead(undefined);
		expect([none.excludeProjects, none.excludeLabels]).toEqual([[], []]);
		const sql = fleetSql(cfgWith({ fleet: { source: "lifeos" } }), NOW - 1000, NOW);
		expect(sql).not.toContain("NOT (");
		expect(sql).not.toContain("'excluded'");
		expect(sql).not.toContain("LEFT JOIN");
	});

	test("names that reach a query must be plain", () => {
		expect(() => parseOverhead({ excludeProjects: ["a'; --"] })).toThrow(
			/excludeProjects must be a list of plain names/,
		);
		expect(() => parseOverhead({ excludeLabels: "assay" })).toThrow(/excludeLabels must be a list of plain names/);
	});
});

describe("the query leaves experiments out of the fleet total and reports them apart", () => {
	const sql = fleetSql(cfg, NOW - 1000, NOW);

	test("the fleet total carries the exclusion, through a LEFT JOIN so a request with no session row stays in", () => {
		const excluded =
			"NOT (coalesce(s.project IN ('lab'), false) OR coalesce(s.labels && ARRAY['assay']::text[], false))";
		expect(sql.split(excluded)).toHaveLength(2);
		expect(sql).toContain("LEFT JOIN sessions");
	});

	test("their own spend is one more slice, selected by the opposite condition", () => {
		const slice = sql.split(" UNION ALL ").find((s) => s.startsWith("SELECT 'excluded'")) ?? "";
		expect(slice).toContain(
			"AND (coalesce(s.project IN ('lab'), false) OR coalesce(s.labels && ARRAY['assay']::text[], false))",
		);
		expect(slice).not.toContain("NOT (");
	});

	test("the answer's excluded row is kept apart: it is not part of the fleet total", () => {
		const f = parseFleet(csv("fleet,h1,200000000", "excluded,excluded,40000000"), cfg);
		expect(f.totalUsd).toBe(200);
		expect(f.excludedUsd).toBe(40);
	});
});

describe("the headline overhead share, and the Steward-only share beside it", () => {
	const answer = (excluded: number) => csv("fleet,h1,200000000", "fleet,h2,100000000", `excluded,excluded,${excluded}`);
	/** The thread ids in Chamberlain's own records, and what their sessions spent: a butler $6, an investigator $4. */
	const launched = { butlers: ["b1"], investigators: ["inv"] };
	const query = (excluded: number) => async (_c: string, a: string[]) =>
		(a[2] ?? "").includes("'mthread'") ? csv("mthread,mac b1,6000000", "mthread,mac inv,4000000") : answer(excluded);
	const report = async (excluded: number) => {
		const store = memStore();
		store.usage.upsert(stewardDay());
		return collect({
			store,
			cfg,
			model: MODEL,
			own: launched,
			gh: async () => ({ total: 0, incomplete: false, items: [] }),
			query: query(excluded),
			now: NOW,
		});
	};

	test("overhead share is (Steward + launched butlers and investigators) / fleet, experiments out of both; Steward-only is Steward / the same fleet", async () => {
		const r = await report(40_000_000);
		expect(r.spendShare).toBeCloseTo((90 + 6 + 4) / 300, 9);
		expect(r.stewardShare).toBeCloseTo(90 / 300, 9);
		expect(r.fleet?.totalUsd).toBe(300);
		expect(r.fleet?.excludedUsd).toBe(40);
	});

	test("what was excluded changes neither share, however large it is", async () => {
		const small = await report(1_000_000);
		const huge = await report(900_000_000_000);
		expect(huge.spendShare).toBe(small.spendShare as number);
		expect(huge.stewardShare).toBe(small.stewardShare as number);
	});

	test("both are shown, with the target when only reported, and the excluded spend is named as in no figure", async () => {
		const r = await report(40_000_000);
		const text = formatOverhead(r);
		expect(text).toMatch(
			/overhead share\s+24 h 33\.3% \(Steward only 30\.0%\)\s+\(report only, target at most 20\.0%\)/,
		);
		expect(text).toContain("EXCLUDED experiments $40.00 (in no figure)");
		expect(summaryLine(summarize(r))).toContain("overhead share 33.3% (Steward only 30.0%)");
	});

	test("a missing host makes both unavailable; no fleet source makes both not configured", async () => {
		const store = memStore();
		store.usage.upsert(stewardDay());
		const gh = async () => ({ total: 0, incomplete: false, items: [] });
		const short = await collect({
			store,
			cfg,
			model: MODEL,
			gh,
			query: async () => csv("fleet,h1,400000000"),
			now: NOW,
		});
		expect([short.spendShare, short.stewardShare]).toEqual([undefined, undefined]);
		const off = await collect({ store, cfg: cfgWith(), model: MODEL, gh, now: NOW });
		expect(summaryLine(summarize(off))).toContain("overhead share not configured");
	});

	test("a share only triggers when the operator made it a trigger, on the headline figure", async () => {
		const trig = cfgWith({
			...{ excludeProjects: ["lab"] },
			fleet: { source: "lifeos" },
			triggers: { spendShare: { mode: "trigger", threshold: 0.2 } },
		});
		const store = memStore();
		store.usage.upsert(stewardDay());
		const r = await collect({
			store,
			cfg: trig,
			model: MODEL,
			gh: async () => ({ total: 0, incomplete: false, items: [] }),
			query: async () => answer(0),
			now: NOW,
		});
		expect(r.crossings.map((c) => c.metric)).toEqual(["spendShare"]);
		expect(r.crossings[0]?.detail).toContain("30.0%");
	});
});

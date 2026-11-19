/** The managed overhead ratio through `collect`: the join, the coverage, the partial ratio, and the trigger that only judges enough coverage. */
import { describe, expect, test } from "bun:test";
import { cfgWith, NOW } from "../../testing/overhead-fixtures.ts";
import {
	fire,
	lifeos,
	managedReport,
	managedStore,
	member,
	type Sessions,
} from "../../testing/overhead-managed-rig.ts";
import { formatOverhead, summarize, summaryLine } from "./format.ts";

const lifeosCfg = (triggers: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
	cfgWith({ fleet: { source: "lifeos", hosts: ["h1", "h2"] }, triggers, ...extra });

/** Ten managed threads on three servers; the sessions of the first `n` of them are in LifeOS, each spending $30 in the window. */
function supervised(n: number) {
	const s = managedStore();
	const sessions: Sessions = {};
	const hosts = ["mithrandir", "mac", "omar"];
	for (let i = 0; i < 10; i++) {
		fire(s, `t${i}`, hosts[i % 3] as string);
		if (i < n) sessions[`t${i}`] = { host: hosts[i % 3] as string, micros: 30_000_000 };
	}
	return { s, sessions };
}

describe("the headline: Chamberlain-caused spend over the spend of the threads it manages", () => {
	test("full coverage: ratio is $90 / (10 threads x $30), cost per thread $9, count 10, not partial", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(s, lifeosCfg(), lifeos(sessions));
		expect(r.managed.status).toBe("ok");
		expect(r.managed.report?.threads).toBe(10);
		expect(r.managed.report?.coverage).toBe(1);
		expect(r.managed.causedUsd).toBeCloseTo(90, 6);
		expect(r.managed.ratio).toBeCloseTo(90 / 300, 9);
		expect(r.managed.costPerThread).toBeCloseTo(9, 9);
		expect(formatOverhead(r)).toMatch(/managed overhead\s+24 h 30\.0% \(10 of 10 threads have sessions\)/);
		expect(formatOverhead(r)).not.toContain("PARTIAL");
	});

	test("the caused spend counts the threads Chamberlain launches and the investigator, as the overhead share does", async () => {
		const { s, sessions } = supervised(10);
		const cfg = lifeosCfg({}, { fleet: { source: "lifeos", spawnedProjects: ["helpers"] } });
		const query = async (c: string, a: string[]) =>
			(a[2] ?? "").includes("'mthread'")
				? lifeos(sessions)(c, a)
				: "k,name,micros\nfleet,h1,300000000\nspawned,helpers,6000000\ninvestigator,investigator,4000000";
		const r = await managedReport(s, cfg, query);
		expect(r.managed.causedUsd).toBeCloseTo(100, 6);
		expect(r.managed.ratio).toBeCloseTo(100 / 300, 9);
	});

	test("threads Chamberlain runs itself are not counted among the managed ones", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(s, lifeosCfg(), lifeos(sessions), ["t0", "t1"]);
		expect(r.managed.report?.threads).toBe(8);
	});

	test("wake and report members count too, and a thread with a fire and a member counts once", async () => {
		const { s, sessions } = supervised(10);
		member(s, "t0");
		member(s, "builder", 4);
		const r = await managedReport(
			s,
			lifeosCfg(),
			lifeos({ ...sessions, builder: { host: "mac", micros: 10_000_000 } }),
		);
		expect(r.managed.report?.threads).toBe(11);
		expect(r.managed.report?.spendUsd).toBeCloseTo(310, 6);
	});
});

describe("partial: a managed thread whose sessions cannot be found", () => {
	test("is reported with its coverage, never as $0: 6 of 10 mapped is 60% coverage, a PARTIAL ratio over the $180 that was found", async () => {
		const { s, sessions } = supervised(6);
		const r = await managedReport(s, lifeosCfg(), lifeos(sessions));
		expect(r.managed.report).toMatchObject({ threads: 10, mapped: 6, unmapped: 4, spendUsd: 180 });
		expect(r.managed.report?.coverage).toBeCloseTo(0.6, 9);
		expect(r.managed.ratio).toBeCloseTo(90 / 180, 9);
		expect(formatOverhead(r)).toContain("50.0%, PARTIAL, coverage 60.0% (6 of 10 threads have sessions)");
		expect(summaryLine(summarize(r))).toContain("managed overhead 50.0%, PARTIAL, coverage 60.0%");
	});

	test("coverage is shown by host, from the server each fire named: mapped over managed", async () => {
		const { s, sessions } = supervised(6);
		const r = await managedReport(s, lifeosCfg(), lifeos(sessions));
		const by = Object.fromEntries((r.managed.report?.byHost ?? []).map((h) => [h.host, `${h.mapped}/${h.managed}`]));
		expect(by).toEqual({ mithrandir: "2/4", mac: "2/3", omar: "2/3" });
		expect(formatOverhead(r)).toContain("mapped/managed by host:");
	});

	test("nothing mapped at all: coverage 0, and no ratio (there is no spend to divide by)", async () => {
		const { s } = supervised(0);
		const r = await managedReport(s, lifeosCfg(), lifeos({}));
		expect(r.managed.report?.coverage).toBe(0);
		expect(r.managed.ratio).toBeUndefined();
		expect(formatOverhead(r)).toContain("unavailable (coverage 0.0% of 10 threads)");
	});

	test("mapped threads that spent nothing in the window leave no ratio, never a division by zero", async () => {
		const s = managedStore();
		fire(s, "idle", "mac");
		const r = await managedReport(s, lifeosCfg(), lifeos({ idle: { host: "mac", micros: 0 } }));
		expect(r.managed.report?.coverage).toBe(1);
		expect(r.managed.ratio).toBeUndefined();
		expect(r.managed.costPerThread).toBeCloseTo(90, 6);
	});

	test("no managed thread in the window", async () => {
		const r = await managedReport(managedStore(), lifeosCfg(), lifeos({}));
		expect(r.managed.report?.threads).toBe(0);
		expect(formatOverhead(r)).toContain("no managed thread in the window");
	});
});

describe("the trigger judges only enough coverage", () => {
	const mode = (o: Record<string, unknown>) => lifeosCfg({ managedRatio: { mode: "trigger", threshold: 0.2, ...o } });

	test("report only (the default) never crosses, however high the ratio", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(
			s,
			lifeosCfg({ managedRatio: { mode: "report", threshold: 0.01 } }),
			lifeos(sessions),
		);
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("report only, target at most 1.0%; judged only at coverage 90.0% or more");
	});

	test("a trigger with full coverage crosses above its threshold, and does not at or below it", async () => {
		const { s, sessions } = supervised(10);
		const over = await managedReport(s, mode({}), lifeos(sessions));
		expect(over.crossings.map((c) => c.metric)).toEqual(["managedRatio"]);
		expect(over.crossings[0]?.detail).toContain("30.0% of what the threads it manages spent (coverage 100.0%)");
		expect((await managedReport(s, mode({ threshold: 0.3 }), lifeos(sessions))).crossings).toEqual([]);
	});

	test("below minCoverage it never crosses, however high the partial ratio: 60% mapped, default 90%", async () => {
		const { s, sessions } = supervised(6);
		const r = await managedReport(s, mode({ threshold: 0.01 }), lifeos(sessions));
		expect(r.managed.ratio).toBeGreaterThan(0.01);
		expect(r.crossings).toEqual([]);
	});

	test("minCoverage is configurable: at 50% the same 60% coverage may cross, and at exactly the coverage it does", async () => {
		const { s, sessions } = supervised(6);
		expect((await managedReport(s, mode({ minCoverage: 0.5 }), lifeos(sessions))).crossings).toHaveLength(1);
		expect((await managedReport(s, mode({ minCoverage: 0.6 }), lifeos(sessions))).crossings).toHaveLength(1);
		expect((await managedReport(s, mode({ minCoverage: 0.61 }), lifeos(sessions))).crossings).toEqual([]);
	});

	test("an unavailable ratio crosses nothing", async () => {
		const { s } = supervised(0);
		expect((await managedReport(s, mode({ minCoverage: 0.01 }), lifeos({}))).crossings).toEqual([]);
	});
});

describe("not configured, and unavailable", () => {
	test("with no fleet source the managed ratio is not configured and nothing is read", async () => {
		const { s } = supervised(3);
		const calls: string[] = [];
		const r = await managedReport(s, cfgWith(), lifeos({}, calls));
		expect(r.managed.status).toBe("not-configured");
		expect(calls).toEqual([]);
		expect(summaryLine(summarize(r))).toContain("managed overhead not configured");
	});

	test("a failing LifeOS read is unavailable, shown as a class and never as the tool's text", async () => {
		const { s } = supervised(3);
		const dummy = `${"gh"}p_${"Y".repeat(36)}`;
		const query = async (_c: string, a: string[]) => {
			if ((a[2] ?? "").includes("'mthread'")) throw Error(`HTTP 500 token ${dummy}`);
			return "k,name,micros\nfleet,h1,300000000\nfleet,h2,0";
		};
		const r = await managedReport(s, lifeosCfg(), query);
		expect(r.managed.status).toBe("unavailable");
		expect(r.unavailable.join(" ")).toContain("managed threads: unavailable (http-5xx)");
		expect(JSON.stringify(r)).not.toContain(dummy);
		expect(r.crossings).toEqual([]);
	});

	test("experiments are left out of the threads' spend by the query, and the managed window is the report's", async () => {
		const { s, sessions } = supervised(10);
		const calls: string[] = [];
		await managedReport(s, lifeosCfg({}, { excludeProjects: ["lab"] }), lifeos(sessions, calls));
		const managedQuery = calls.find((q) => q.includes("'mthread'")) ?? "";
		expect(managedQuery).toContain("NOT (coalesce(s.project IN ('lab'), false))");
		expect(managedQuery).toContain(`to_timestamp(${Math.floor((NOW - 24 * 3_600_000) / 1000)})`);
	});
});

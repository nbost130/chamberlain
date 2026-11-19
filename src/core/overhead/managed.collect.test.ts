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

	test("the caused spend counts the butlers and investigators Chamberlain launched, found by the thread ids in its own records", async () => {
		const { s, sessions } = supervised(10);
		const all: Sessions = {
			...sessions,
			b1: { host: "mac", micros: 4_000_000 },
			b2: { host: "omar", micros: 2_000_000 },
			inv: { host: "mithrandir", micros: 4_000_000 },
		};
		const r = await managedReport(s, lifeosCfg(), lifeos(all), { butlers: ["b1", "b2"], investigators: ["inv"] });
		expect(r.launched).toEqual({ butlers: 2, investigators: 1, butlersUsd: 6, investigatorsUsd: 4, unmapped: 0 });
		expect(r.managed.causedUsd).toBeCloseTo(100, 6);
		expect(r.managed.ratio).toBeCloseTo(100 / 300, 9);
		expect(r.spendShare).toBeCloseTo(100 / 300, 9);
		expect(formatOverhead(r)).toContain(
			"launched by Chamberlain (its own records): butlers $6.00 (2 threads), investigators $4.00 (1)",
		);
	});

	test("a session that merely sits in a project or has a title like a butler's is not a launched thread: only the records count", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(
			s,
			lifeosCfg(),
			lifeos({ ...sessions, lookalike: { host: "mac", micros: 50_000_000 } }),
		);
		expect(r.launched).toEqual({ butlers: 0, investigators: 0, butlersUsd: 0, investigatorsUsd: 0, unmapped: 0 });
		expect(r.managed.causedUsd).toBeCloseTo(90, 6);
	});

	test("a launched thread with no LifeOS session is said so and adds nothing: its spend is unknown, never $0 that looks measured", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(s, lifeosCfg(), lifeos({ ...sessions, b1: { host: "mac", micros: 4_000_000 } }), {
			butlers: ["b1", "b2"],
		});
		expect(r.launched).toMatchObject({ butlers: 2, butlersUsd: 4, unmapped: 1 });
		expect(r.unavailable.join(" ")).toContain("Chamberlain-launched threads: 1 of 2 have no LifeOS session");
		expect(formatOverhead(r)).toContain("1 with no session");
	});

	test("when the launched threads' spend cannot be read, the caused spend and the shares are unavailable, never short", async () => {
		const { s } = supervised(10);
		const query = async (_c: string, a: string[]) => {
			if ((a[2] ?? "").includes("'b1'")) throw Error("LifeOS query failed: no route");
			return (a[2] ?? "").includes("'mthread'")
				? "k,name,micros"
				: "k,name,micros\nfleet,h1,200000000\nfleet,h2,100000000";
		};
		const r = await managedReport(s, lifeosCfg(), query, { butlers: ["b1"] });
		expect(r.launched).toBeUndefined();
		expect(r.managed.causedUsd).toBeUndefined();
		expect(r.fleetStatus).toBe("ok");
		expect(r.spendShare).toBeUndefined();
		expect(r.unavailable.join(" ")).toContain("Chamberlain-launched threads: unavailable (other)");
	});

	test("threads Chamberlain runs itself (pinned, butlers, investigators) are not counted among the managed ones, even when they fire", async () => {
		const { s, sessions } = supervised(10);
		fire(s, "b1", "mac");
		const r = await managedReport(s, lifeosCfg(), lifeos(sessions), {
			pinned: ["t0"],
			butlers: ["b1"],
			investigators: ["t1"],
		});
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
		expect(formatOverhead(r)).toContain(
			"report only, target at most 1.0%; judged only at full coverage with every fleet host reporting (reporting bar 90.0%)",
		);
	});

	test("a trigger with full coverage crosses above its threshold, and does not at or below it", async () => {
		const { s, sessions } = supervised(10);
		const over = await managedReport(s, mode({}), lifeos(sessions));
		expect(over.crossings.map((c) => c.metric)).toEqual(["managedRatio"]);
		expect(over.crossings[0]?.detail).toContain("30.0% of what the threads it manages spent (coverage 100.0%)");
		expect((await managedReport(s, mode({ threshold: 0.3 }), lifeos(sessions))).crossings).toEqual([]);
	});

	test("below full coverage it never crosses, however high the partial ratio: 60% mapped, default 90% bar", async () => {
		const { s, sessions } = supervised(6);
		const r = await managedReport(s, mode({ threshold: 0.01 }), lifeos(sessions));
		expect(r.managed.ratio).toBeGreaterThan(0.01);
		expect(r.crossings).toEqual([]);
	});

	test("a partial ratio never crosses, whatever minCoverage says: 60% coverage at a 50% bar, and 90% coverage at exactly the 90% bar", async () => {
		const sixty = supervised(6);
		const r = await managedReport(sixty.s, mode({ minCoverage: 0.5 }), lifeos(sixty.sessions));
		expect(r.managed.ratio).toBeGreaterThan(0.2);
		expect(r.crossings).toEqual([]);
		const ninety = supervised(9);
		const edge = await managedReport(ninety.s, mode({ minCoverage: 0.9 }), lifeos(ninety.sessions));
		expect(edge.managed.report).toMatchObject({ threads: 10, mapped: 9, unmapped: 1, coverage: 0.9 });
		expect(edge.managed.ratio).toBeGreaterThan(0.2);
		expect(edge.crossings).toEqual([]);
		expect(formatOverhead(edge)).toContain("PARTIAL");
	});

	test("a launched butler or investigator whose spend is missing counts in the coverage and blocks a trigger, though the ratio is still shown", async () => {
		const { s, sessions } = supervised(10);
		const r = await managedReport(s, mode({}), lifeos(sessions), { butlers: ["b1"], investigators: ["inv"] });
		expect(r.launched).toMatchObject({ butlers: 1, investigators: 1, unmapped: 2 });
		expect(r.managed.report?.coverage).toBe(1); // the managed threads alone are fully mapped
		expect(r.managed.unmapped).toBe(2);
		expect(r.managed.coverage).toBeCloseTo(10 / 12, 9);
		expect(r.managed.ratio).toBeGreaterThan(0.2);
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("PARTIAL");
		expect(summarize(r).managed?.coverage).toBeCloseTo(10 / 12, 9);
	});

	test("with every launched thread mapped as well, the same trigger crosses", async () => {
		const { s, sessions } = supervised(10);
		const all: Sessions = { ...sessions, b1: { host: "mac", micros: 4_000_000 } };
		const r = await managedReport(s, mode({}), lifeos(all), { butlers: ["b1"] });
		expect(r.managed.coverage).toBe(1);
		expect(r.crossings.map((c) => c.metric)).toEqual(["managedRatio"]);
	});

	test("only full mapping crosses: the same threads with the tenth session found do", async () => {
		const { s, sessions } = supervised(10);
		expect((await managedReport(s, mode({ minCoverage: 0.9 }), lifeos(sessions))).crossings).toHaveLength(1);
	});

	test("an unavailable ratio crosses nothing", async () => {
		const { s } = supervised(0);
		expect((await managedReport(s, mode({ minCoverage: 0.01 }), lifeos({}))).crossings).toEqual([]);
	});

	test("a configured fleet host with no rows is a short total: the managed ratio is reported and does not trigger, as the share does not", async () => {
		const { s, sessions } = supervised(10);
		const query = async (c: string, a: string[]) => {
			const out = await lifeos(sessions)(c, a);
			return out.startsWith("k,name,micros\nfleet") ? "k,name,micros\nfleet,h1,200000000" : out;
		};
		const r = await managedReport(s, mode({}), query);
		expect(r.fleet?.missingHosts).toEqual(["h2"]);
		expect(r.managed.ratio).toBeGreaterThan(0.2);
		expect(r.crossings).toEqual([]);
		expect(r.unavailable.join(" ")).toContain("spend share and managed ratio: no fleet rows for h2");
	});

	test("a fleet that cannot be read cannot vouch for its hosts: the managed ratio does not trigger", async () => {
		const { s, sessions } = supervised(10);
		const ok = lifeos(sessions);
		const query = async (c: string, a: string[]) => {
			if (!(a[2] ?? "").includes("'mthread'")) throw Error("LifeOS query failed: no route");
			return ok(c, a);
		};
		const r = await managedReport(s, mode({}), query);
		expect(r.fleetStatus).toBe("unavailable");
		expect(r.managed.ratio).toBeGreaterThan(0.2);
		expect(r.crossings).toEqual([]);
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

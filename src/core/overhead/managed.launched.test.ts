/** Butlers and investigators Chamberlain launched (its own records) in the coverage, the caused spend, the share and the managed ratio. */
import { describe, expect, test } from "bun:test";
import { cfgWith } from "../../testing/overhead-fixtures.ts";
import { fire, lifeos, managedReport, managedStore, type Sessions } from "../../testing/overhead-managed-rig.ts";
import { formatOverhead, summarize } from "./format.ts";

const lifeosCfg = (triggers: Record<string, unknown> = {}) =>
	cfgWith({ fleet: { source: "lifeos", hosts: ["h1", "h2"] }, triggers });
const ratio = lifeosCfg({ managedRatio: { mode: "trigger", threshold: 0.2 } });

/** Ten managed threads, all with sessions, each spending $30 in the window. */
function supervised() {
	const s = managedStore();
	const sessions: Sessions = {};
	for (let i = 0; i < 10; i++) {
		fire(s, `t${i}`, "mac");
		sessions[`t${i}`] = { host: "mac", micros: 30_000_000 };
	}
	return { s, sessions };
}

describe("a launched thread with no LifeOS session", () => {
	test("counts in the coverage, and the caused spend, the ratio and the share are unavailable", async () => {
		const { s, sessions } = supervised();
		const r = await managedReport(s, ratio, lifeos(sessions), { butlers: ["b1"], investigators: ["inv"] });
		expect(r.launched).toMatchObject({ butlers: 1, investigators: 1, unmapped: 2 });
		expect(r.managed.report?.coverage).toBe(1); // the managed threads alone are fully mapped
		expect(r.managed.unmapped).toBe(2);
		expect(r.managed.coverage).toBeCloseTo(10 / 12, 9);
		expect(r.managed.causedUsd).toBeUndefined();
		expect(r.managed.ratio).toBeUndefined();
		expect(r.spendShare).toBeUndefined();
		expect(r.crossings).toEqual([]);
		expect(formatOverhead(r)).toContain("unavailable (coverage 83.3% of 10 threads)");
		expect(summarize(r).managed?.coverage).toBeCloseTo(10 / 12, 9);
	});

	test("makes the spend share unavailable too: a trigger on it does not cross on a short numerator", async () => {
		const { s, sessions } = supervised();
		const share = lifeosCfg({ spendShare: { mode: "trigger", threshold: 0.01 } });
		const mapped = await managedReport(s, share, lifeos({ ...sessions, b1: { host: "mac", micros: 1_000_000 } }), {
			butlers: ["b1"],
		});
		expect(mapped.crossings.map((c) => c.metric)).toEqual(["spendShare"]);
		const r = await managedReport(s, share, lifeos(sessions), { butlers: ["b1"] });
		expect(r.launched?.unmapped).toBe(1);
		expect(r.spendShare).toBeUndefined();
		expect(r.stewardShare).toBeGreaterThan(0); // the Steward's own share does not depend on the launched threads
		expect(r.crossings).toEqual([]);
		expect(r.unavailable.join(" ")).toContain(
			"the caused spend, the spend share and the managed ratio are unavailable",
		);
	});
});

describe("a launched thread with a session", () => {
	test("leaves the coverage full, and the same managed trigger crosses", async () => {
		const { s, sessions } = supervised();
		const all: Sessions = { ...sessions, b1: { host: "mac", micros: 4_000_000 } };
		const r = await managedReport(s, ratio, lifeos(all), { butlers: ["b1"] });
		expect(r.managed.coverage).toBe(1);
		expect(r.crossings.map((c) => c.metric)).toEqual(["managedRatio"]);
	});
});

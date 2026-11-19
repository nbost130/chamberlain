import { describe, expect, test } from "bun:test";
import { cfgWith, NOW } from "../../testing/overhead-fixtures.ts";
import { fleetSpend, fleetSql, parseFleet } from "./fleet-spend.ts";

const cfg = cfgWith({
	fleet: { source: "lifeos", command: "fleet-query", hosts: ["h1", "h2", "h3"] },
});

/** What the query tool prints: a few `key: value` lines, the CSV, then its help lines. */
const answer = (rows: string[]) =>
	["host: box", "role: reader", "format: csv", "", "k,name,micros", ...rows, "help[1]:", "  Prefer views"].join("\n");

describe("the fleet query", () => {
	test("is one read-only SELECT over the window, built from numbers and plain names only", () => {
		const sql = fleetSql(cfg, NOW - 3_600_000, NOW);
		expect(sql).toMatch(/^SELECT /);
		expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i);
		expect(sql).not.toContain(";");
		expect(sql).toContain(`to_timestamp(${Math.floor((NOW - 3_600_000) / 1000)})`);
		expect(sql).toContain("GROUP BY o.host");
	});

	test("has no project or title slice: the threads Chamberlain launched are read by thread id from its own records, not found here", () => {
		const sql = fleetSql(cfg, NOW - 1000, NOW);
		expect(sql).not.toContain("'spawned'");
		expect(sql).not.toContain("'investigator'");
		expect(sql).not.toContain("LIKE");
		expect(sql).not.toContain("s.project IN");
	});
});

describe("reading the answer", () => {
	test("sums the hosts in dollars, names a host with no rows, and keeps the excluded experiments apart", () => {
		const f = parseFleet(answer(["fleet,h1,50000000", "fleet,h2,25000000", "excluded,excluded,9000000"]), cfg);
		expect(f.totalUsd).toBeCloseTo(75, 6);
		expect(f.byHost).toEqual({ h1: 50, h2: 25 });
		expect(f.excludedUsd).toBe(9);
		expect(f.missingHosts).toEqual(["h3"]);
	});

	test("an answer with no fleet rows is an error, never a total of zero", () => {
		expect(() => parseFleet(answer([]), cfg)).toThrow(/no fleet rows/);
		expect(() => parseFleet("error: query failed", cfg)).toThrow(/no fleet rows/);
	});
});

describe("running it", () => {
	test("calls the configured command with query --sql, and returns the parsed spend", async () => {
		const calls: { command: string; args: string[] }[] = [];
		const run = async (command: string, args: string[]) => {
			calls.push({ command, args });
			return answer(["fleet,h1,4000000"]);
		};
		const f = await fleetSpend(cfg, NOW - 1000, NOW, run);
		expect(f.totalUsd).toBe(4);
		expect(calls[0]?.command).toBe("fleet-query");
		expect(calls[0]?.args.slice(0, 2)).toEqual(["query", "--sql"]);
	});

	test("a command that fails rejects, so the caller reports unavailable", async () => {
		const run = async () => {
			throw Error("LifeOS query failed: not found");
		};
		await expect(fleetSpend(cfg, NOW - 1000, NOW, run)).rejects.toThrow(/not found/);
	});
});

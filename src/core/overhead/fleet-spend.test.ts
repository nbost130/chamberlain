import { describe, expect, test } from "bun:test";
import { cfgWith, NOW } from "../../testing/overhead-fixtures.ts";
import { fleetSpend, fleetSql, parseFleet } from "./fleet-spend.ts";

const cfg = cfgWith({
	fleet: { source: "lifeos", command: "fleet-query", hosts: ["h1", "h2", "h3"], spawnedProjects: ["evals", "helpers"] },
	investigator: { title: "Overhead check" },
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
		expect(sql).toContain("s.project IN ('evals', 'helpers')");
		expect(sql).toContain("s.title LIKE 'Overhead check%'");
	});

	test("with no spawned projects, the spawned slice is left out of the statement rather than emitted as IN ()", () => {
		const sql = fleetSql(cfgWith({ fleet: { source: "lifeos" } }), NOW - 1000, NOW);
		expect(sql).not.toContain("IN ()");
		expect(sql).not.toContain("'spawned'");
	});
});

describe("reading the answer", () => {
	test("sums the hosts, the spawned projects and the investigator, in dollars, and names a host with no rows", () => {
		const f = parseFleet(
			answer([
				"fleet,h1,50000000",
				"fleet,h2,25000000",
				"spawned,evals,10000000",
				"spawned,helpers,2500000",
				"investigator,investigator,1500000",
			]),
			cfg,
		);
		expect(f.totalUsd).toBeCloseTo(75, 6);
		expect(f.byHost).toEqual({ h1: 50, h2: 25 });
		expect(f.spawnedUsd).toBeCloseTo(12.5, 6);
		expect(f.investigatorUsd).toBeCloseTo(1.5, 6);
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

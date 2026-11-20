import { describe, expect, test } from "bun:test";
import { cfgWith, NOW } from "../../testing/overhead-fixtures.ts";
import { managedSpend, managedSql, parseManaged } from "./managed-spend.ts";

const span = { from: NOW - 3_600_000, to: NOW };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `mcp:launch:${i.toString(16).padStart(8, "0")}`);

describe("the managed spend query", () => {
	const cfg = cfgWith({ fleet: { source: "lifeos" } });

	test("is one read-only SELECT over the sessions of the listed T3 threads, summing their requests in the window", () => {
		const sql = managedSql(cfg, ["a:1", "b%3A2"], span.from, span.to);
		expect(sql).toMatch(/^SELECT /);
		expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i);
		expect(sql).not.toContain(";");
		expect(sql).toContain("s.metadata->>'t3_thread_id' IN ('a:1', 'b%3A2')");
		expect(sql).toContain("FROM sessions s LEFT JOIN otel_api_requests o ON o.session_id = s.id");
		expect(sql).toContain(`to_timestamp(${Math.floor(span.from / 1000)})`);
	});

	test("a thread whose requests fall outside the window still comes back as a row (a LEFT JOIN, the window inside the sum), so it is mapped", () => {
		const sql = managedSql(cfg, ["a"], span.from, span.to);
		expect(sql).toContain("sum(o.cost_usd_micros) FILTER (WHERE o.occurred_at >=");
		expect(sql).toContain("coalesce(round(");
	});

	test("with nothing excluded the sum has no exclusion; with experiments excluded, only the sum leaves them out, so their threads stay mapped", () => {
		expect(managedSql(cfg, ["a"], span.from, span.to)).not.toContain("NOT (");
		const ex = cfgWith({ fleet: { source: "lifeos" }, excludeProjects: ["lab"], excludeLabels: ["assay"] });
		const sql = managedSql(ex, ["a"], span.from, span.to);
		expect(sql).toContain(
			"AND NOT (coalesce(s.project IN ('lab'), false) OR coalesce(s.labels && ARRAY['assay']::text[], false))",
		);
		expect(sql).not.toMatch(/WHERE s\.metadata[^F]*NOT \(/);
	});
});

describe("reading the answer", () => {
	test("rows are `mthread,<host> <thread id>,<micro-dollars>`; the tool's other lines are ignored", () => {
		const out = [
			"host: box",
			"k,name,micros",
			"mthread,mac thread:subagent:abc,2500000",
			"mthread,omar mcp:launch:def,0",
			"help[1]:",
		].join("\n");
		expect(parseManaged(out)).toEqual([
			{ host: "mac", id: "thread:subagent:abc", usd: 2.5 },
			{ host: "omar", id: "mcp:launch:def", usd: 0 },
		]);
	});
});

describe("running it", () => {
	test("asks in batches of 100 ids, so each answer fits the tool's row limit, and joins every batch's rows", async () => {
		const asked: string[] = [];
		const run = async (_c: string, args: string[]) => {
			asked.push(args[2] as string);
			expect(args.slice(3)).toEqual(["--limit", "200"]);
			const first = /IN \('([^']+)'/.exec(args[2] as string)?.[1];
			return `k,name,micros\nmthread,mac ${first},1000000`;
		};
		const rows = await managedSpend(cfgWith({ fleet: { source: "lifeos" } }), ids(230), span, run);
		expect(asked).toHaveLength(3);
		expect(rows.map((r) => r.id)).toEqual([ids(230)[0], ids(230)[100], ids(230)[200]]);
	});

	test("an id that is not plain text is never put in a statement: it can only stay unmapped", async () => {
		const asked: string[] = [];
		const run = async (_c: string, args: string[]) => {
			asked.push(args[2] as string);
			return "k,name,micros";
		};
		await managedSpend(
			cfgWith({ fleet: { source: "lifeos" } }),
			["good:1", "bad'; DROP TABLE sessions; --", "with space", ""],
			span,
			run,
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("'good:1'");
		expect(asked[0]).not.toContain("DROP");
		expect(asked[0]).not.toContain("with space");
	});

	test("no ids asks nothing", async () => {
		let called = false;
		await managedSpend(cfgWith({ fleet: { source: "lifeos" } }), [], span, async () => {
			called = true;
			return "";
		});
		expect(called).toBe(false);
	});

	test("one failing batch rejects the whole read: a coverage over some of the batches would be a made-up number", async () => {
		let n = 0;
		const run = async () => {
			if (++n === 2) throw Error("LifeOS query failed");
			return "k,name,micros";
		};
		await expect(managedSpend(cfgWith({ fleet: { source: "lifeos" } }), ids(150), span, run)).rejects.toThrow(
			/LifeOS query failed/,
		);
	});
});

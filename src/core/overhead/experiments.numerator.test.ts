/** Experiments are out of the NUMERATOR too: Chamberlain's own Steward and classifier spend for an experiment's session or thread counts as nothing. */
import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, MODEL, NOW, wake } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import type { DispositionWrite } from "../store/store-records.ts";
import { collect } from "./collect.ts";
import { experimentsSql, parseExperiments } from "./experiments.ts";
import { parseFleet } from "./fleet-spend.ts";
import { formatOverhead } from "./format.ts";

const FLEET = "k,name,micros\nfleet,h1,200000000\nfleet,h2,100000000";
const cfg = (extra: Record<string, unknown> = {}) =>
	cfgWith({
		excludeProjects: ["lab"],
		fleet: { source: "lifeos", hosts: ["h1", "h2"] },
		...extra,
	});

const disposition = (threadId: string, costUsd: number): DispositionWrite => ({
	server: "main",
	threadId,
	messageHash: `h-${threadId}`,
	bankVersion: "b1",
	classifiedAt: NOW - 2 * HOUR,
	provider: "haiku",
	model: "m",
	mode: "live",
	action: "ignore",
	reasons: [],
	answers: {},
	idleMinutes: 10,
	sentChars: 100,
	redactions: 0,
	inputTokens: 100,
	costUsd,
	latencyMs: 10,
	error: null,
});

/** 5 turns of $9 from a real Steward session and 5 from a session of the experiments project; $3 and $7 of classifier calls on a real and an experiment thread. */
function stores() {
	const s = memStore();
	s.usage.upsert([
		...Array.from({ length: 5 }, (_, i) => wake({ hoursAgo: 1 + i, usd: 9, tools: 1 })),
		...Array.from({ length: 5 }, (_, i) => ({
			...wake({ hoursAgo: 6 + i, usd: 9, tools: 0 }),
			session: "lab-session",
		})),
	]);
	s.dispositions.put(disposition("real-thread", 3));
	s.dispositions.put(disposition("lab-thread", 7));
	return s;
}

/** A LifeOS that names `lab-session` and `lab-thread` as experiments and answers the fleet with a fixed total. */
const lifeos =
	(calls: string[] = [], fail = false) =>
	async (_command: string, args: string[]): Promise<string> => {
		const sql = args[2] ?? "";
		calls.push(sql);
		if (sql.includes("'xsession'") || sql.includes("'xthread'")) {
			if (fail) throw Error("LifeOS query failed: no route");
			return [
				"k,name,micros",
				...(sql.includes("'lab-session'") ? ["xsession,lab-session,0"] : []),
				...(sql.includes("'lab-thread'") ? ["xthread,lab-thread,0"] : []),
			].join("\n");
		}
		return FLEET;
	};

const run = (c: ReturnType<typeof cfg>, store = stores(), query = lifeos()) =>
	collect({
		store,
		cfg: c,
		model: MODEL,
		gh: async () => ({ total: 0, incomplete: false, items: [] }),
		query,
		now: NOW,
	});

describe("the numerator leaves out Steward turns and classifier calls made for experiments", () => {
	test("a Steward turn read from an experiment's session is in no window: $45 of the $90, five of the ten turns", async () => {
		const r = await run(cfg());
		expect(r.day.turns).toBe(5);
		expect(r.day.stewardUsd).toBeCloseTo(45, 6);
	});

	test("so is a classifier call made for a thread an experiment's session ran for: $3 of the $10", async () => {
		const r = await run(cfg());
		expect(r.day.classifierUsd).toBeCloseTo(3, 6);
		expect(r.day.basisUsd).toBeCloseTo(48, 6);
	});

	test("the no-op rate is over the real turns only: the experiment's five no-op turns do not count", async () => {
		const r = await run(cfg());
		expect(r.day.noopRate).toBe(0);
	});

	test("the share's numerator and denominator both leave experiments out", async () => {
		const r = await run(cfg());
		expect(r.spendShare).toBeCloseTo(48 / 300, 9);
	});

	test("without any exclusion configured nothing is looked up and every turn counts", async () => {
		const calls: string[] = [];
		const r = await run(cfgWith({ fleet: { source: "lifeos" } }), stores(), lifeos(calls));
		expect(calls.some((c) => c.includes("'xsession'") || c.includes("'xthread'"))).toBe(false);
		expect(r.day.turns).toBe(10);
		expect(r.day.classifierUsd).toBeCloseTo(10, 6);
	});

	test("a lookup that fails leaves the money figures and the no-op rate unavailable, so nothing triggers; the note names the class only", async () => {
		const r = await run(
			cfg({ triggers: { noopRate: { mode: "trigger", threshold: 0.01, minWakes: 1 } } }),
			stores(),
			lifeos([], true),
		);
		expect(r.day.stewardUsd).toBeUndefined();
		expect(r.day.basisUsd).toBeUndefined();
		expect(r.day.noopRate).toBeUndefined();
		expect(r.crossings).toEqual([]);
		expect(r.spendShare).toBeUndefined();
		const note = r.unavailable.join(" ");
		expect(note).toContain("experiment exclusion: unavailable (other)");
		expect(note).not.toContain("no route");
	});
});

describe("an exclusion that is configured and cannot be applied is never skipped", () => {
	const noop = { noopRate: { mode: "trigger", threshold: 0.01, minWakes: 1 } };

	test("with excludeProjects set and no LifeOS source (fleet off), the money figures and the no-op rate are unavailable and nothing triggers", async () => {
		const calls: string[] = [];
		const r = await run(cfgWith({ excludeProjects: ["lab"], triggers: noop }), stores(), lifeos(calls));
		expect(r.day.stewardUsd).toBeUndefined();
		expect(r.day.basisUsd).toBeUndefined();
		expect(r.day.noopRate).toBeUndefined();
		expect(r.crossings).toEqual([]);
		expect(r.unavailable.join(" ")).toContain('experiment exclusion: overhead.fleet.source is "off"');
		expect(calls).toEqual([]);
	});

	test("every money figure goes unavailable, the classifier's included, in every window and in the text", async () => {
		const r = await run(cfgWith({ excludeProjects: ["lab"], triggers: noop }));
		for (const w of [r.day, r.baseline, r.trailing, ...r.trend]) {
			expect(w.classifierUsd).toBeUndefined();
			expect(w.stewardUsd).toBeUndefined();
			expect(w.basisUsd).toBeUndefined();
			expect(w.costPerPr).toBeUndefined();
			expect(w.costPerUsefulWake).toBeUndefined();
		}
		expect(r.spendShare).toBeUndefined();
		expect(r.stewardShare).toBeUndefined();
		expect(r.managed.causedUsd).toBeUndefined();
		const text = formatOverhead(r);
		expect(text).toContain("classifier unavailable");
		expect(text).not.toMatch(/\$(10|3|7)\.00/);
	});

	test("the same for excludeLabels alone", async () => {
		const r = await run(cfgWith({ excludeLabels: ["assay"], triggers: noop }));
		expect(r.day.noopRate).toBeUndefined();
		expect(r.crossings).toEqual([]);
	});

	test("an id that cannot be put in a statement leaves the exclusion unapplied: unavailable, not skipped", async () => {
		const s = memStore();
		s.usage.upsert([{ ...wake({ hoursAgo: 1, usd: 9, tools: 0 }), session: "bad id; drop" }]);
		const r = await run(cfg({ triggers: noop }), s);
		expect(r.day.noopRate).toBeUndefined();
		expect(r.crossings).toEqual([]);
		expect(r.unavailable.join(" ")).toContain("experiment exclusion: unavailable");
	});

	test("with nothing excluded and fleet off, nothing is unavailable for that reason: the figures stand and may trigger", async () => {
		const r = await run(cfgWith({ triggers: noop }));
		expect(r.day.noopRate).toBeCloseTo(0.5, 9);
		expect(r.crossings.map((c) => c.metric)).toEqual(["noopRate"]);
		expect(r.unavailable.join(" ")).not.toContain("experiment exclusion");
	});
});

describe("the lookup statements", () => {
	test("by session id, and by the T3 thread id a session ran for, with the same exclusion as the fleet total", () => {
		const s = experimentsSql(cfg(), "session", ["a", "b"]);
		expect(s).toContain("FROM sessions s WHERE s.id IN ('a', 'b') AND (coalesce(s.project IN ('lab'), false))");
		const t = experimentsSql(cfg(), "thread", ["a"]);
		expect(t).toContain("s.metadata->>'t3_thread_id' IN ('a')");
	});

	test("an answer's rows are read, and the tool's own lines are ignored", () => {
		expect(parseExperiments("k,name,micros\nxsession,s-1,0\nxthread,mcp:launch:abc,0\nnoise")).toEqual({
			sessions: ["s-1"],
			threads: ["mcp:launch:abc"],
		});
	});
});

describe("a host is looked up as a key, never on a prototype", () => {
	test("hosts named like inherited properties are missing when no row names them", () => {
		const hosts = ["constructor", "toString", "hasOwnProperty", "valueOf", "mac"];
		const c = cfgWith({ fleet: { source: "lifeos", hosts } });
		const f = parseFleet("k,name,micros\nfleet,mac,1000000\nfleet,__proto__,5000000", c);
		expect(f.missingHosts).toEqual(["constructor", "toString", "hasOwnProperty", "valueOf"]);
		expect(f.totalUsd).toBeCloseTo(6, 9);
	});

	test("a host that really reports under such a name is found, and counted once", () => {
		const c = cfgWith({ fleet: { source: "lifeos", hosts: ["constructor"] } });
		const f = parseFleet("k,name,micros\nfleet,constructor,2000000\nfleet,mac,1000000", c);
		expect(f.missingHosts).toEqual([]);
		expect(f.totalUsd).toBeCloseTo(3, 9);
		expect(f.byHost.constructor).toBeCloseTo(2, 9);
	});
});

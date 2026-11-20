import { describe, expect, test } from "bun:test";
import { HOUR, NOW } from "../../testing/overhead-fixtures.ts";
import { joinManaged, managedFigures, managedThreads } from "./managed.ts";

const from = NOW - 24 * HOUR;
const ev = (id: unknown, o: Record<string, unknown> = {}) => ({
	t: new Date(NOW - 2 * HOUR).toISOString(),
	event: "fire",
	server: "mac",
	kind: "turn_ended",
	threadId: id,
	...o,
});
const find = (events: object[], members: { thread?: string; queuedAt: number }[] = [], own: string[] = []) =>
	managedThreads({ events: events as never, members, own: new Set(own), from, to: NOW });

describe("which threads are managed", () => {
	test("a thread Chamberlain fired a wake for in the window, with the server the event named", () => {
		expect(find([ev("t1", { server: "omar" })])).toEqual([{ id: "t1", server: "omar" }]);
	});

	test("a thread named by a wake or report queued in the window, with no server", () => {
		expect(find([], [{ thread: "t2", queuedAt: NOW - HOUR }])).toEqual([{ id: "t2" }]);
	});

	test("a thread seen by both counts once and keeps the fire's server", () => {
		expect(find([ev("t1")], [{ thread: "t1", queuedAt: NOW - HOUR }])).toEqual([{ id: "t1", server: "mac" }]);
	});

	test("outside the window, not a fire, no thread: nothing", () => {
		const old = ev("old", { t: new Date(from - HOUR).toISOString() });
		const later = ev("later", { t: new Date(NOW).toISOString() });
		const other = ev("x", { event: "skip-turn-ended" });
		const noId = ev(undefined);
		expect(find([old, later, other, noId], [{ thread: "m", queuedAt: from - 1 }, { queuedAt: NOW - HOUR }])).toEqual(
			[],
		);
	});

	test("the Steward's own thread being compacted is not a managed thread", () => {
		expect(
			find([ev("steward-thread", { kind: "compact", server: "steward" }), ev("s2", { server: "steward" })]),
		).toEqual([]);
	});

	test("threads Chamberlain runs itself (pinned, butlers, investigators) are never managed, from either source", () => {
		const got = find([ev("pinned"), ev("t1")], [{ thread: "butler", queuedAt: NOW - HOUR }], ["pinned", "butler"]);
		expect(got.map((t) => t.id)).toEqual(["t1"]);
	});
});

describe("joining the managed threads to the spend of their sessions", () => {
	const threads = [
		{ id: "a", server: "mac" },
		{ id: "b", server: "mithrandir" },
		{ id: "c" },
		{ id: "d", server: "omar" },
	];

	test("a thread with a session row is mapped, whatever it spent; one with none is unmapped; coverage is mapped over managed", () => {
		const r = joinManaged(threads, [
			{ id: "a", host: "mac", usd: 10 },
			{ id: "b", host: "mithrandir", usd: 0 },
			{ id: "c", host: "omar", usd: 5 },
		]);
		expect([r.threads, r.mapped, r.unmapped]).toEqual([4, 3, 1]);
		expect(r.coverage).toBeCloseTo(0.75, 9);
		expect(r.spendUsd).toBe(15);
	});

	test("an unmapped thread's spend is unknown: it adds nothing, and is not counted as $0 into anything", () => {
		const r = joinManaged(threads, [{ id: "a", host: "mac", usd: 10 }]);
		expect(r.spendUsd).toBe(10);
		expect(r.unmapped).toBe(3);
	});

	test("hosts: the server a fire named, else the host of the thread's sessions, else unknown; each with mapped over managed", () => {
		const r = joinManaged(threads, [
			{ id: "a", host: "mac", usd: 1 },
			{ id: "c", host: "omar", usd: 1 },
		]);
		const by = Object.fromEntries(r.byHost.map((h) => [h.host, `${h.mapped}/${h.managed}`]));
		expect(by).toEqual({ mac: "1/1", mithrandir: "0/1", omar: "1/2" });
		expect(joinManaged([{ id: "z" }], []).byHost).toEqual([{ host: "unknown", managed: 1, mapped: 0 }]);
	});

	test("a session row for a thread that is not managed is ignored", () => {
		expect(joinManaged([{ id: "a" }], [{ id: "other", host: "mac", usd: 99 }]).spendUsd).toBe(0);
	});

	test("no managed thread has no coverage, and no division", () => {
		const r = joinManaged([], []);
		expect([r.threads, r.mapped, r.coverage]).toEqual([0, 0, undefined]);
	});
});

describe("the ratio and the cost per managed thread", () => {
	const report = (spendUsd: number, threads = 4) => ({ threads, mapped: threads, unmapped: 0, spendUsd, byHost: [] });

	test("ratio is caused spend over the mapped threads' spend; cost per thread is caused spend over the thread count", () => {
		expect(managedFigures(60, report(300, 5))).toEqual({ ratio: 0.2, costPerThread: 12 });
	});

	test("never divides by zero: no mapped spend means no ratio, no managed thread means no cost per thread", () => {
		expect(managedFigures(60, report(0))).toEqual({ costPerThread: 15 });
		expect(managedFigures(60, report(100, 0))).toEqual({ ratio: 0.6 });
	});

	test("an unknown or non-finite caused spend gives nothing", () => {
		expect(managedFigures(undefined, report(100))).toEqual({});
		expect(managedFigures(Number.NaN, report(100))).toEqual({});
		expect(managedFigures(Number.POSITIVE_INFINITY, report(100))).toEqual({});
	});
});

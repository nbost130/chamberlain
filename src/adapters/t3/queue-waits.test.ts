import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../../testing/store.ts";
import { analyze, type Delivered, format, fromDeliveryId, pct, readRuns, stat, wakesFrom } from "./queue-waits.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const T0 = Date.parse("2026-11-11T10:00:00.000Z");
const at = (sec: number) => T0 + Math.round(sec * 1000);
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (o: Record<string, unknown>) => o as unknown as Delivered;
const delivered = (sec: number, deliveryId: string, extra: Record<string, unknown> = {}, http = 202) =>
	ev({ t: iso(at(sec)), event: "delivered", deliveryId, http, attempt: 1, ...extra });

describe("percentiles", () => {
	test("nearest rank", () => {
		expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
		expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(stat([30, 10, 20])).toEqual({ n: 3, p50: 20, p90: 30, max: 30 });
		expect(stat([])).toBeUndefined();
	});
});

describe("the delivery ID records what the log may not", () => {
	test("thread wakes and sweeps end in the millisecond they were made; an answer carries none", () => {
		expect(fromDeliveryId("thr-1:ended:1789120000123:1789120000456")).toEqual({
			kind: "turn_ended",
			thread: "thr-1",
			createdAt: 1789120000456,
		});
		expect(fromDeliveryId("mcp:launch:abc:input:req-9:1789120000456")).toEqual({
			kind: "needs_input",
			thread: "mcp:launch:abc",
			createdAt: 1789120000456,
		});
		expect(fromDeliveryId("thr-2:failed:running:1789120000456")).toMatchObject({
			kind: "failed",
			thread: "thr-2",
			createdAt: 1789120000456,
		});
		expect(fromDeliveryId("sweep:1789120000456")).toEqual({ kind: "sweep", createdAt: 1789120000456 });
		expect(fromDeliveryId("answer:item:Q-abcd")).toEqual({ kind: "answer" });
	});
});

describe("wakesFrom", () => {
	test("keeps accepted posts in the window, once each; skips failures, compact, noise and the old", () => {
		const lines = [
			delivered(10, "a", { queuedAt: at(5), kind: "turn_ended", thread: "A" }),
			delivered(11, "a", { queuedAt: at(5), kind: "turn_ended", thread: "A" }), // the crash window's second post
			delivered(12, "b", {}, 503),
			delivered(13, `compact:x:${at(13)}`),
			delivered(-99999, "old"),
			ev({ t: iso(at(20)), event: "fire", kind: "turn_ended" }),
		];
		expect(wakesFrom(lines, at(-3600)).map((w) => w.deliveryId)).toEqual(["a"]);
	});

	test("reads the event log with SQL: only delivered events in the window come out of the database", () => {
		const store = memStore();
		for (const e of [
			delivered(10, "a", { queuedAt: at(5), kind: "turn_ended", thread: "A" }),
			delivered(12, "b", {}, 503),
			ev({ t: iso(at(20)), event: "fire", kind: "turn_ended" }),
			delivered(-99999, "old"),
		])
			store.events.append(e as never);
		const rows = store.events.query({ events: ["delivered"], since: iso(at(-3600)) }) as Delivered[];
		expect(rows.map((r) => r.deliveryId)).toEqual(["a", "b"]);
		expect(wakesFrom(rows, at(-3600)).map((w) => w.deliveryId)).toEqual(["a"]);
	});

	test("a digest's members are each a wake, with their own queue times", () => {
		const lines = [
			delivered(100, "digest:abc", {
				members: [
					{ deliveryId: "m1", queuedAt: at(10), kind: "turn_ended", thread: "A" },
					{ deliveryId: "m2", queuedAt: at(50), kind: "sweep" },
				],
			}),
		];
		const w = wakesFrom(lines, 0);
		expect(w.map((x) => [x.deliveryId, x.kind, x.thread, x.createdAt, x.createdFrom, x.postedAt])).toEqual([
			["m1", "turn_ended", "A", at(10), "recorded", at(100)],
			["m2", "sweep", undefined, at(50), "recorded", at(100)],
		]);
	});
});

/** A small T3 state database: the Steward's runs, plus one run on another thread. */
function fixtureDb() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-qw-`);
	dirs.push(root);
	const path = `${root}/state.sqlite`;
	const db = new Database(path);
	db.run(
		"create table orchestration_v2_projection_runs (run_id text, thread_id text, ordinal int, status text, requested_at text, completed_at text, payload_json text)",
	);
	let n = 0;
	const run = (thread: string, req: number, start: number | null, done: number | null) =>
		db.run("insert into orchestration_v2_projection_runs values (?,?,?,?,?,?,?)", [
			`r${++n}`,
			thread,
			n,
			done ? "completed" : start ? "running" : "queued",
			iso(at(req)),
			done ? iso(at(done)) : null,
			JSON.stringify({ startedAt: start === null ? null : iso(at(start)) }),
		]);
	return { path, db, run };
}

describe("analyze over a small fixture", () => {
	const lines = [
		// A turn end held 40s by chamberlain, then 20s in T3's queue behind a long turn: total 60s.
		delivered(100, "A:ended:1:2", { queuedAt: at(60), kind: "turn_ended", thread: "A" }),
		// A needs_input posted at once, started in 5s.
		delivered(200, "B:input:req:3", { queuedAt: at(199), kind: "needs_input", thread: "B" }),
		// An old-format record: creation time read from the delivery ID, kind and thread too.
		delivered(300, `C:ended:x:${at(250)}`),
		// An answer wake with no creation time anywhere.
		delivered(400, "answer:item:Q-1"),
		// A post that no run answers.
		delivered(500, `D:ended:x:${at(490)}`, { queuedAt: at(490), kind: "turn_ended", thread: "D" }),
	];
	test("waits, turn lengths, the worst waits, and what could not be measured", () => {
		const { path, run, db } = fixtureDb();
		run("steward", 99.5, 160, 175); // wake A's run: 60.5s in T3's queue, then a 15s turn
		run("steward", 199.4, 204.4, 220); // wake B's
		run("steward", 299, 330, 340); // wake C's
		run("steward", 399, 399.5, 410); // the answer's
		run("steward", 700, 701, 731); // a run nothing in the log woke: only its 30s turn counts
		run("other", 200, 201, 202); // another thread's run: ignored
		db.close();
		const runs = readRuns(path, "steward", at(-600));
		expect(runs).toHaveLength(5);
		const r = analyze(wakesFrom(lines, at(-600)), runs, 24, at(600));
		expect(r.wakes).toMatchObject({ posted: 5, matched: 4, unmatched: 1, noCreationTime: 1, createdFromId: 1 });
		// A: started 160 - created 60 = 100s. B: 204.4 - 199 = 5.4s. C: 330 - 250 = 80s.
		expect(r.totalWait).toEqual({ n: 3, p50: 80_000, p90: 100_000, max: 100_000 });
		// Held: A 99.5 - 60 = 39.5s, B 0.4s, C 299 - 250 = 49s.
		expect(r.heldWait).toEqual({ n: 3, p50: 39_500, p90: 49_000, max: 49_000 });
		// T3 queue: A 160 - 99.5 = 60.5s, B 5s, C 31s, and the answer's 0.5s (measured though its creation is not): 0.5, 5, 31, 60.5.
		expect(r.t3Wait).toEqual({ n: 4, p50: 5_000, p90: 60_500, max: 60_500 });
		// Turns: 15, 15.6, 10, 10.5 and 30 seconds across the Steward's five runs.
		expect(r.turns).toEqual({ n: 5, p50: 15_000, p90: 30_000, max: 30_000 });
		expect(r.worst.map((w) => [w.deliveryId, w.kind, w.thread, w.waitMs])).toEqual([
			["A:ended:1:2", "turn_ended", "A", 100_000],
			[`C:ended:x:${at(250)}`, "turn_ended", "C", 80_000],
			["B:input:req:3", "needs_input", "B", 5_400],
		]);
		const text = format(r);
		expect(text).toContain("5 worst waits");
		expect(text).toContain("no creation time in the log");
		expect(text).toContain("took their creation time from the millisecond in their delivery ID");
		expect(text).toContain("matched no Steward run");
		expect(text).toContain("by time only");
	});

	test("only the five worst are listed, worst first, and an empty window says so instead of inventing numbers", () => {
		const many = Array.from({ length: 8 }, (_, i) =>
			delivered(100 + i * 100, `T${i}:ended:x:1`, {
				queuedAt: at(100 + i * 100 - 1 - i),
				kind: "turn_ended",
				thread: `T${i}`,
			}),
		);
		const { path, run, db } = fixtureDb();
		for (let i = 0; i < 8; i++) run("steward", 100 + i * 100 - 1, 100 + i * 100 + 5, 100 + i * 100 + 50);
		db.close();
		const r = analyze(wakesFrom(many, 0), readRuns(path, "steward", at(0)), 24, at(2000));
		expect(r.worst).toHaveLength(5);
		expect(r.worst.map((w) => w.waitMs)).toEqual([...r.worst.map((w) => w.waitMs)].sort((a, b) => b - a));
		expect(r.worst[0]!.thread).toBe("T7");
		const none = analyze([], [], 24, at(0));
		expect(none.totalWait).toBeUndefined();
		expect(format(none)).toContain("no data");
		expect(format(none)).toContain("No accepted wake posts");
	});

	test("a matched run that has not started yet is reported, not counted", () => {
		const { path, run, db } = fixtureDb();
		run("steward", 99, null, null);
		db.close();
		const r = analyze(
			wakesFrom([delivered(100, "A:ended:1:2", { queuedAt: at(60), kind: "turn_ended", thread: "A" })], 0),
			readRuns(path, "steward", at(0)),
			24,
			at(600),
		);
		expect(r.totalWait).toBeUndefined();
		expect(r.wakes.notStarted).toBe(1);
		expect(format(r)).toContain("had not started yet");
	});
});

describe("read-only", () => {
	test("it opens T3's database read-only: a write through its handle is refused", () => {
		const { path, db } = fixtureDb();
		db.close();
		const ro = new Database(path, { readonly: true });
		expect(() => ro.run("delete from orchestration_v2_projection_runs")).toThrow();
		ro.close();
		expect(readRuns(path, "steward", 0)).toEqual([]);
	});
});

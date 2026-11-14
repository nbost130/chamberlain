import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { compactBlocked, queueGate, queueStalled, readStewardQueue, type StewardQueue, stallAlarm } from "./queue.ts";

const at = (s: string) => Date.parse(`2026-11-07T${s}Z`);
const MIN = 60_000;
const STALL = 20 * MIN;
const iso = (s: string) => `2026-11-07T${s}.000Z`;

describe("queueStalled", () => {
	const q = (o: Partial<StewardQueue>): StewardQueue => ({ queued: 1, compactPending: false, ...o });
	test("an empty queue is never stalled", () =>
		expect(queueStalled({ queued: 0, compactPending: false }, at("12:00:00"), STALL)).toBe(false));
	test("a wake younger than the limit is fine", () =>
		expect(queueStalled(q({ oldestQueuedAt: iso("11:45:00") }), at("12:00:00"), STALL)).toBe(false));
	test("an old wake with no recent turn is stalled", () =>
		expect(
			queueStalled(q({ oldestQueuedAt: iso("11:30:00"), lastActivityAt: iso("11:29:00") }), at("12:00:00"), STALL),
		).toBe(true));
	test("an old wake behind a long turn that is still working is not", () =>
		expect(
			queueStalled(q({ oldestQueuedAt: iso("11:30:00"), lastActivityAt: iso("11:50:00") }), at("12:00:00"), STALL),
		).toBe(false));
	test("a queue with no turn ever started is stalled", () =>
		expect(queueStalled(q({ oldestQueuedAt: iso("11:30:00") }), at("12:00:00"), STALL)).toBe(true));
});

describe("queueGate: can a wake go to the Steward without queueing behind another turn", () => {
	test("idle only when nothing is working and nothing is queued", () =>
		expect(queueGate({ queued: 0, running: 0, compactPending: false })).toBe("idle"));
	test("a turn working is busy", () =>
		expect(queueGate({ queued: 0, running: 1, compactPending: false })).toBe("busy"));
	test("a queued turn is busy, a queued /compact included", () => {
		expect(queueGate({ queued: 1, running: 0, compactPending: false })).toBe("busy");
		expect(queueGate({ queued: 1, running: 0, compactPending: true })).toBe("busy");
	});
	test("a queue that can't be read is unknown, never idle", () => expect(queueGate(undefined)).toBe("unknown"));
});

describe("compactBlocked", () => {
	const clear: StewardQueue = { queued: 0, compactPending: false, lastActivityAt: iso("11:59:00") };
	test("a clear queue allows it", () => expect(compactBlocked(clear, at("12:00:00"), STALL)).toBeUndefined());
	test("wakes moving normally allow it", () =>
		expect(
			compactBlocked({ ...clear, queued: 2, oldestQueuedAt: iso("11:58:00") }, at("12:00:00"), STALL),
		).toBeUndefined());
	test("never a second one", () =>
		expect(compactBlocked({ ...clear, compactPending: true }, at("12:00:00"), STALL)).toBe(
			"one is already queued or running",
		));
	test("not while the Steward is on its own card", () =>
		expect(compactBlocked({ ...clear, openCardSince: iso("11:59:30") }, at("12:00:00"), STALL)).toContain("card"));
	test("not while the queue is stuck", () =>
		expect(
			compactBlocked(
				{ queued: 3, compactPending: false, oldestQueuedAt: iso("11:00:00"), lastActivityAt: iso("11:00:00") },
				at("12:00:00"),
				STALL,
			),
		).toContain("stopped"));
});

test("the 2026-11-07 stall: the compact is refused at once and the alarm fires at 03:04:52Z, not at 13:17Z", () => {
	const q: StewardQueue = {
		queued: 1,
		compactPending: false,
		oldestQueuedAt: iso("02:41:21"),
		lastActivityAt: iso("02:44:52"),
		openCardSince: iso("02:44:52"),
	};
	expect(compactBlocked(q, at("02:45:41"), STALL)).toContain("card");
	expect(queueStalled(q, at("03:04:51"), STALL)).toBe(false);
	expect(queueStalled(q, at("03:04:53"), STALL)).toBe(true);
	const a = stallAlarm({ ...q, queued: 9 }, at("03:21:21"));
	expect(a.title).toContain("card");
	expect(a.summary).toContain("9 wakes queued, the oldest for 40 minutes");
});

test("the alarm without a card says to look at the turn", () => {
	const a = stallAlarm({ queued: 1, compactPending: false, oldestQueuedAt: iso("11:30:00") }, at("12:00:00"));
	expect(a.title).toContain("stopped taking wakes");
	expect(a.summary).toContain("1 wake queued");
});

describe("readStewardQueue", () => {
	const seed = () => {
		const path = `${mkdtempSync(`${tmpdir()}/queue-`)}/state.sqlite`;
		const db = new Database(path);
		db.run(
			"create table orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, payload_json text)",
		);
		db.run("create table orchestration_v2_projection_messages (message_id text, payload_json text)");
		db.run(
			"create table orchestration_v2_projection_runtime_requests (thread_id text, created_at text, resolved_at text)",
		);
		db.run("create table orchestration_v2_projection_turn_items (thread_id text, type text, updated_at text)");
		const run = (r: { t: string; n: number; status: string; at: string; started: string | null; msg: string }) =>
			db.run("insert into orchestration_v2_projection_runs values (?,?,?,?,?)", [
				r.t,
				r.n,
				r.status,
				r.at,
				JSON.stringify({ startedAt: r.started, userMessageId: r.msg }),
			]);
		const msg = (id: string, text: string) =>
			db.run("insert into orchestration_v2_projection_messages values (?,?)", [id, JSON.stringify({ text })]);
		return { path, db, run, msg };
	};
	test("reads the queue, the last start, any compact and any open card", () => {
		const { path, db, run, msg } = seed();
		msg("m1", "/steward-wake\n\nsomething");
		msg("m2", "/compact");
		run({ t: "s", n: 1, status: "completed", at: "2026-11-07T01:00:00Z", started: "2026-11-07T01:00:01Z", msg: "m1" });
		run({ t: "s", n: 2, status: "running", at: "2026-11-07T02:00:00Z", started: "2026-11-07T02:00:01Z", msg: "m1" });
		run({ t: "s", n: 3, status: "queued", at: "2026-11-07T02:10:00Z", started: null, msg: "m1" });
		run({ t: "s", n: 4, status: "queued", at: "2026-11-07T02:20:00Z", started: null, msg: "m2" });
		run({ t: "s", n: 5, status: "cancelled", at: "2026-11-07T02:30:00Z", started: null, msg: "m2" });
		run({ t: "other", n: 1, status: "queued", at: "2026-11-07T00:00:00Z", started: null, msg: "m1" });
		db.run("insert into orchestration_v2_projection_runtime_requests values ('s','2026-11-07T02:05:00Z',null)");
		db.run(
			"insert into orchestration_v2_projection_runtime_requests values ('s','2026-11-07T01:05:00Z','2026-11-07T01:06:00Z')",
		);
		db.close();
		expect(readStewardQueue(path, "s")).toEqual({
			queued: 2,
			running: 1,
			oldestQueuedAt: "2026-11-07T02:10:00Z",
			compactPending: true,
			lastActivityAt: "2026-11-07T02:00:01Z",
			openCardSince: "2026-11-07T02:05:00Z",
		});
	});
	test("a working turn counts as activity, and a wake arriving does not", () => {
		const { path, db, run, msg } = seed();
		msg("m1", "/steward-wake");
		run({ t: "s", n: 1, status: "running", at: "2026-11-07T02:00:00Z", started: "2026-11-07T02:00:01Z", msg: "m1" });
		db.run(
			"insert into orchestration_v2_projection_turn_items values ('s','command_execution','2026-11-07T02:25:00Z')",
		);
		db.run("insert into orchestration_v2_projection_turn_items values ('s','user_message','2026-11-07T02:40:00Z')");
		db.close();
		expect(readStewardQueue(path, "s")?.lastActivityAt).toBe("2026-11-07T02:25:00Z");
	});
	test("every state of a turn that is not finished reads as busy, and finished ones read idle", () => {
		const gate = (status: string) => {
			const { path, db, run, msg } = seed();
			msg("m1", "/steward-wake");
			run({
				t: "s",
				n: 1,
				status: "completed",
				at: "2026-11-07T01:00:00Z",
				started: "2026-11-07T01:00:01Z",
				msg: "m1",
			});
			run({ t: "s", n: 2, status, at: "2026-11-07T02:00:00Z", started: null, msg: "m1" });
			db.close();
			return queueGate(readStewardQueue(path, "s"));
		};
		for (const s of ["queued", "starting", "preparing", "running"]) expect([s, gate(s)]).toEqual([s, "busy"]);
		for (const s of ["completed", "failed", "cancelled", "interrupted"]) expect([s, gate(s)]).toEqual([s, "idle"]);
	});
	test("a running compact counts, so a second is not sent while it works", () => {
		const { path, db, run, msg } = seed();
		msg("m2", "/compact");
		run({ t: "s", n: 1, status: "running", at: "2026-11-07T02:00:00Z", started: "2026-11-07T02:00:01Z", msg: "m2" });
		db.close();
		const q = readStewardQueue(path, "s");
		expect(q?.compactPending).toBe(true);
		expect(q?.queued).toBe(0);
	});
	test("an orphaned request from before the latest turn is not an open card, so compaction can't starve", () => {
		const { path, db, run, msg } = seed();
		msg("m1", "/steward-wake");
		run({ t: "s", n: 1, status: "running", at: "2026-11-07T02:00:00Z", started: "2026-11-07T02:00:01Z", msg: "m1" });
		db.run("insert into orchestration_v2_projection_runtime_requests values ('s','2026-11-06T01:00:00Z',null)");
		db.close();
		expect(readStewardQueue(path, "s")?.openCardSince).toBeUndefined();
	});
	test("a wake that only mentions /compact is not a compact", () => {
		const { path, db, run, msg } = seed();
		msg("m1", "/steward-wake\n\nthe thread said /compact");
		run({ t: "s", n: 1, status: "queued", at: "2026-11-07T02:10:00Z", started: null, msg: "m1" });
		db.close();
		expect(readStewardQueue(path, "s")?.compactPending).toBe(false);
	});
	test("a thread with no runs reads clear", () => {
		const { path, db } = seed();
		db.close();
		expect(readStewardQueue(path, "s")).toEqual({
			queued: 0,
			running: 0,
			oldestQueuedAt: undefined,
			compactPending: false,
			lastActivityAt: undefined,
			openCardSince: undefined,
		});
	});
	test("a database it can't read is unknown, not clear", () => {
		expect(readStewardQueue("/nonexistent/state.sqlite", "s")).toBeUndefined();
		const { path, db } = seed();
		db.run("drop table orchestration_v2_projection_runs");
		db.close();
		expect(readStewardQueue(path, "s")).toBeUndefined();
	});
});

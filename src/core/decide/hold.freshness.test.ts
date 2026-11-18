/** What a digest says about each held item now: freshness of turn-end reports, which sweeps fold, and which items the store marks. */
import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import { fullSweepHead } from "../messages.ts";
import { segmentTranscript } from "../steward/steward-segments.ts";
import { composeWake, type HeldItem, type ThreadNews } from "./hold.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T01:00:00Z");
const te = (id: string, thread: string, queuedAt: number): HeldItem => ({
	deliveryId: id,
	message: `report ${id}`,
	queuedAt,
	kind: "turn_ended",
	thread,
});
/** Two reports so composeWake writes item headers (a lone item goes as itself). */
const header = (news: ThreadNews, queuedAt = T0) => {
	const c = composeWake([te("a", "T1", queuedAt), te("b", "T2", queuedAt + 1)], T0 + 30 * MIN, {
		news: (t) => (t === "T1" ? news : {}),
	});
	return c.message.split("\n").find((l) => l.includes("deliveryId: a "))!;
};

describe("freshness of a held turn-end report", () => {
	test("watched without a break and no turn start since: current, stamped with the time it was composed", () => {
		expect(header({ watchedSince: T0 - 60 * MIN, lastTurnStart: T0 - 30 * MIN })).toContain(
			"as of 01:30 UTC its thread had started no new turn since this report",
		);
		expect(header({ watchedSince: T0 - 60 * MIN })).toContain("had started no new turn since");
	});
	test("a turn start after the report: says when, and to read the thread", () => {
		expect(header({ watchedSince: T0 - 60 * MIN, lastTurnStart: T0 + 5 * MIN })).toContain(
			"its thread started a new turn at 01:05 UTC, after this report: read it before acting",
		);
	});
	test("a turn start it cannot place (just before the report), a gap in watching, or no watch: not confirmed", () => {
		expect(header({ watchedSince: T0 - 60 * MIN, lastTurnStart: T0 - 30_000 })).toContain("not confirmed current");
		expect(header({ watchedSince: T0 - 30_000 })).toContain("not confirmed current");
		expect(header({})).toContain("not confirmed current");
	});
	test("no view of threads, or another kind: no note", () => {
		const plain = composeWake([te("a", "T1", T0), te("b", "T2", T0)], T0);
		expect(plain.message).not.toContain("new turn");
		const note: HeldItem = { deliveryId: "n", message: "note", queuedAt: T0, kind: "note", thread: "T1" };
		const c = composeWake([note, te("b", "T2", T0)], T0, { news: () => ({ watchedSince: 0 }) });
		expect(c.message.match(/no new turn/g)).toHaveLength(1);
	});
});

describe("which sweeps fold", () => {
	test("full-sweep reminders fold to the newest; findings and the idle-thread list never do", () => {
		const full = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: `${fullSweepHead()}\nrun it`,
			queuedAt: at,
			kind: "sweep",
		});
		const findings = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: "[chamberlain] sweep: the routine checks found the items below.",
			queuedAt: at,
			kind: "sweep",
		});
		const idle = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: "[chamberlain] idle threads: 2 top-level threads",
			queuedAt: at,
			kind: "sweep",
		});
		const c = composeWake(
			[full("f1", 1), full("f2", 2), findings("s1", 3), findings("s2", 4), idle("i1", 5), idle("i2", 6)],
			10,
		);
		expect(c.folded).toBe(1);
		expect(c.kept).toEqual(["f2", "s1", "s2", "i1", "i2"]);
		expect(c.members).toHaveLength(6);
	});
});

describe("the store's superseded marks", () => {
	test("only the thread's held turn-end reports held before the moment, once each", () => {
		const s = memStore();
		s.wakes.hold(te("a", "T1", 100));
		s.wakes.hold(te("late", "T1", 500));
		s.wakes.hold(te("other", "T2", 100));
		s.wakes.hold({ deliveryId: "n", message: "note", queuedAt: 100, kind: "note", thread: "T1" });
		expect(s.wakes.supersedeHeld("T1", 300, "settled")).toEqual(["a"]);
		expect(s.wakes.supersedeHeld("T1", 300, "archived")).toEqual([]);
		expect(s.wakes.superseded()).toEqual([{ deliveryId: "a", at: 300, why: "settled" }]);
	});
	test("a mark cannot be deleted while its wake is held, and can once it has left", () => {
		const s = memStore();
		s.wakes.hold(te("a", "T1", 100));
		s.wakes.supersedeHeld("T1", 300, "settled");
		expect(() => s.wakes.forgetStatus(["a"])).toThrow("keeps its status");
		const row = s.wakes.compose(
			400,
			() => ({ deliveryId: "superseded:x", message: "m", folded: 0, members: ["a"] }),
			null,
		)!;
		s.wakes.cancel(row.deliveryId, 400);
		s.wakes.forgetStatus(["a"]);
		expect(s.wakes.superseded()).toEqual([]);
	});
});

describe("tool calls per Steward turn", () => {
	const user = JSON.stringify({
		type: "user",
		uuid: "u1",
		timestamp: "2026-11-18T01:00:00Z",
		message: { role: "user", content: "check on the builders" },
	});
	const asst = (id: string, parent: string, content: unknown[]) =>
		JSON.stringify({
			type: "assistant",
			uuid: `a-${id}`,
			parentUuid: parent,
			timestamp: "2026-11-18T01:00:05Z",
			message: {
				id,
				model: "claude-opus-5-5",
				usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 },
				content,
			},
		});
	test("counts each tool call once, and only real thread reads; a repeated row never unmarks one", async () => {
		const rows = [
			user,
			asst("m1", "u1", [{ type: "tool_use", id: "t1", name: "mcp__t3-code__t3_thread_read", input: {} }]),
			asst("m2", "a-m1", [
				{
					type: "tool_use",
					id: "t2",
					name: "Bash",
					input: { command: "cd ~/app; bun src/adapters/t3/peek.ts mac abc" },
				},
			]),
			asst("m2", "a-m2", [{ type: "tool_use", id: "t2", name: "Bash" }]),
			asst("m3", "a-m2", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "echo peek at it later" } }]),
			asst("m4", "a-m3", [
				{ type: "tool_use", id: "t4", name: "Bash", input: { command: "chamberlain debug peek mac abc" } },
			]),
		];
		const [seg] = await segmentTranscript(rows, "s1");
		expect(seg).toMatchObject({ kind: "message", requests: 4, toolCalls: 4, threadReads: 3 });
	});
});

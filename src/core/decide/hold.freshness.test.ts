/** What a digest says about each held item now: freshness of turn-end reports, which sweeps fold, and which items the store marks. */
import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import { fullSweepHead } from "../messages.ts";
import { segmentTranscript } from "../steward/steward-segments.ts";
import { composeWake, type HeldItem } from "./hold.ts";

const te = (id: string, thread: string, queuedAt: number): HeldItem => ({
	deliveryId: id,
	message: `report ${id}`,
	queuedAt,
	kind: "turn_ended",
	thread,
});

describe("freshness of a held turn-end report", () => {
	test("held while the daemon watched: its thread has not started a new turn since", () => {
		const c = composeWake([te("a", "T1", 100), te("b", "T2", 200)], 1_000, { watchedSince: 50 });
		expect(c.message.match(/its thread has not started a new turn since/g)).toHaveLength(2);
	});
	test("held before the daemon restarted: may have moved on, check before acting", () => {
		const c = composeWake([te("a", "T1", 100), te("b", "T2", 200)], 1_000, { watchedSince: 150 });
		expect(c.message).toContain("deliveryId: a · held 0 min · held across a daemon restart");
		expect(c.message).toContain("deliveryId: b · held 0 min · its thread has not started a new turn since");
	});
	test("other kinds carry no note", () => {
		const note: HeldItem = { deliveryId: "n", message: "note", queuedAt: 100, kind: "note", thread: "T1" };
		const c = composeWake([note, te("b", "T2", 200)], 1_000, { watchedSince: 50 });
		expect(c.message.match(/new turn since/g)).toHaveLength(1);
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
		expect(s.wakes.supersedeHeld("T1", 300, "new-turn")).toEqual(["a"]);
		expect(s.wakes.supersedeHeld("T1", 300, "settled")).toEqual([]);
		expect(s.wakes.superseded()).toEqual([{ deliveryId: "a", at: 300, why: "new-turn" }]);
	});
});

describe("tool calls per Steward turn", () => {
	test("counts each tool call once, and the ones that read another thread", async () => {
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
		const rows = [
			user,
			asst("m1", "u1", [{ type: "tool_use", id: "t1", name: "mcp__t3-code__t3_thread_read", input: {} }]),
			asst("m1", "a-m1", [{ type: "tool_use", id: "t1", name: "mcp__t3-code__t3_thread_read", input: {} }]),
			asst("m2", "a-m1", [
				{
					type: "tool_use",
					id: "t2",
					name: "Bash",
					input: { command: "cd ~/app; bun src/adapters/t3/peek.ts mac abc" },
				},
			]),
			asst("m3", "a-m2", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "gh-axi pr view 7" } }]),
		];
		const [seg] = await segmentTranscript(rows, "s1");
		expect(seg).toMatchObject({ kind: "message", requests: 3, toolCalls: 3, threadReads: 2 });
	});
});

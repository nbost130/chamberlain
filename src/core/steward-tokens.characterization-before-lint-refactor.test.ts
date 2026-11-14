/** steward-tokens, continued: see steward-tokens.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { session } from "../testing/core-steward-tokens-fixtures.ts";
import { sessionTrends } from "./steward-report.ts";
import { classifyPrompt, segmentTranscript } from "./steward-segments.ts";
import { parseBackfillArgs, type WakeUsage } from "./steward-tokens.ts";

describe("characterization before the lint refactor", () => {
	const json = (x: object) => JSON.stringify(x);
	const user = (uuid: string, content: unknown, extra: object = {}) =>
		json({ type: "user", uuid, timestamp: "2026-11-10T10:00:00Z", message: { content }, ...extra });
	const reply = (uuid: string, id: string | undefined, usage: object | undefined, extra: object = {}) =>
		json({
			type: "assistant",
			uuid,
			timestamp: "2026-11-10T10:00:05Z",
			message: { ...(id ? { id } : {}), model: "claude-test", ...(usage ? { usage } : {}) },
			...extra,
		});
	const wakeText = "[chamberlain] sweep: time for a full supervision sweep";

	test("blank and malformed lines and sidechain rows are skipped", async () => {
		const segs = await segmentTranscript(
			[
				"",
				"   ",
				"{not json",
				json({ isSidechain: true, type: "user", uuid: "s", message: { content: "ignored" } }),
				user("u1", "hello there"),
				reply("a1", "m1", { input_tokens: 3, output_tokens: 2 }),
			],
			session,
		);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({
			wakeKey: "uuid:u1",
			kind: "message",
			requests: 1,
			inputTokens: 3,
			outputTokens: 2,
		});
	});

	test("a prompt's text blocks are joined; an image alone is a message; a tool result, a meta row and a compaction summary are no prompt", async () => {
		const segs = await segmentTranscript(
			[
				user("u1", [{ type: "text", text: wakeText }, { type: "text", text: "second block" }, { type: "image" }]),
				user("u2", [{ type: "image" }]),
				user("u3", [{ type: "tool_result", content: "x" }]),
				user("u4", "meta text", { isMeta: true }),
				user("u5", "summary text", { isCompactSummary: true }),
				user("u6", "result text", { toolUseResult: {} }),
				user("u7", []),
				user("u8", null),
			],
			session,
		);
		expect(segs.map((x) => [x.wakeKey, x.kind, x.variant])).toEqual([
			["uuid:u1", "sweep", "full"],
			["uuid:u2", "message", undefined],
		]);
	});

	test("an assistant row with no usage, no request id or a synthetic model is not counted; the rest of a request follows its first row", async () => {
		const segs = await segmentTranscript(
			[
				user("u1", "start the work"),
				reply("a0", "m0", undefined),
				json({ type: "assistant", message: { model: "claude-test", usage: { input_tokens: 9 } } }),
				reply("a1", "m1", { input_tokens: 1 }, { parentUuid: "u1" }),
				json({
					type: "assistant",
					uuid: "a2",
					message: { id: "m2", model: "<synthetic>", usage: { input_tokens: 500 } },
				}),
				reply("a3", "m1", { input_tokens: 1, output_tokens: 7 }),
			],
			session,
		);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({ requests: 1, inputTokens: 1, outputTokens: 7 });
	});

	test("negative, missing and non-numeric usage fields count as zero", async () => {
		const segs = await segmentTranscript(
			[
				user("u1", "go"),
				reply("a1", "m1", { input_tokens: -4, cache_read_input_tokens: "9", cache_creation_input_tokens: 6 }),
			],
			session,
		);
		expect(segs[0]).toMatchObject({
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 6,
			outputTokens: 0,
			contextStart: 6,
			contextEnd: 6,
			contextPeak: 6,
		});
	});

	test("a segment with no counted request has no context figures, and its times come from its prompt", async () => {
		const segs = await segmentTranscript([user("u1", "idle prompt")], session);
		expect(segs[0]).toMatchObject({ requests: 0, startedAt: Date.parse("2026-11-10T10:00:00Z") });
		expect(segs[0]).not.toHaveProperty("contextStart");
	});

	test("a compaction boundary is counted in its parent's segment, and before any prompt it is counted nowhere", async () => {
		const boundary = (uuid: string, parentUuid?: string) =>
			json({ type: "system", subtype: "compact_boundary", uuid, ...(parentUuid ? { parentUuid } : {}) });
		const none = await segmentTranscript([boundary("b0")], session);
		expect(none).toEqual([]);
		const segs = await segmentTranscript([user("u1", "go"), boundary("b1"), boundary("b2", "u1")], session);
		expect(segs[0]!.compactions).toBe(2);
	});

	test("the compact command is recognised near the start of a prompt only", () => {
		expect(classifyPrompt("<command-name>/compact</command-name>")).toEqual({ kind: "compact" });
		expect(classifyPrompt(`${"y".repeat(100)}<command-name>/compact</command-name>`)).toEqual({ kind: "compact" });
		expect(classifyPrompt(`${"y".repeat(250)}<command-name>/compact</command-name>`)).toEqual({ kind: "message" });
		expect(classifyPrompt("You are the new Steward of this thread")).toEqual({ kind: "start" });
		expect(classifyPrompt("Update on pull request #12: merged")).toEqual({ kind: "notice" });
		expect(classifyPrompt("Delegated task finished")).toEqual({ kind: "notice" });
		expect(classifyPrompt("   ")).toBeUndefined();
	});

	test("a sweep is full or findings; other kinds carry no variant; the delivery id comes from the last line", () => {
		expect(classifyPrompt("[chamberlain] sweep: only the listed checks")).toEqual({
			kind: "sweep",
			variant: "findings",
		});
		expect(classifyPrompt(`${wakeText}\ndelivery id: sweep:1 (the same id again is a repeat`)).toEqual({
			kind: "sweep",
			variant: "full",
			deliveryId: "sweep:1",
		});
		expect(classifyPrompt("[t3-wake] failed: x")).toEqual({ kind: "failed" });
		expect(classifyPrompt("<webhook-data-ab12>[chamberlain] needs_input: x")).toEqual({ kind: "needs_input" });
	});

	test("sessions are ordered by first wake; growth is measured after the last compaction", () => {
		const row = (sessionId: string, i: number, over: Partial<WakeUsage> = {}): WakeUsage => ({
			session: sessionId,
			wakeKey: `${sessionId}-${i}`,
			kind: "turn_ended",
			startedAt: 1000 + i,
			endedAt: 1000 + i,
			requests: 1,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			compactions: 0,
			...over,
		});
		const rows = [
			row("late", 50, { contextStart: 10, contextPeak: 12 }),
			row("early", 3, { contextStart: 500, contextPeak: 900 }),
			row("early", 1, { contextStart: 100, contextPeak: 100, compactions: 1 }),
			row("early", 2, { contextStart: 200, contextPeak: 300 }),
			row("early", 4, { contextStart: 400, contextPeak: 450 }),
			row("early", 5, { kind: "message" }),
		];
		const [first, second] = sessionTrends(rows);
		expect(first).toEqual({
			session: "early",
			firstAt: 1001,
			wakes: 4,
			contextFirst: 100,
			contextLast: 400,
			contextPeak: 900,
			growthPerWake: 100,
		});
		expect(second).toEqual({
			session: "late",
			firstAt: 1050,
			wakes: 1,
			contextFirst: 10,
			contextLast: 10,
			contextPeak: 12,
			growthPerWake: undefined,
		});
	});

	test("backfill arguments: a dangling --dir and a non-transcript file are refused", () => {
		expect(() => parseBackfillArgs(["--dir"])).toThrow("--dir needs a folder");
		expect(() => parseBackfillArgs(["a.jsonl", "b.txt"])).toThrow("not a transcript (.jsonl): b.txt");
		expect(parseBackfillArgs(["a.jsonl", "--dir", "/x", "b.jsonl"])).toEqual({
			dir: "/x",
			files: ["a.jsonl", "b.jsonl"],
		});
	});
});

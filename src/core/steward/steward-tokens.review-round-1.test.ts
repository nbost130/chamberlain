/** steward-tokens, continued: see steward-tokens.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureText, session } from "../../testing/core-steward-tokens-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { classifyPrompt, segmentTranscript } from "./steward-segments.ts";
import { parseBackfillArgs, USAGE_INTERVAL_MS, USAGE_KEY, usageTicker } from "./steward-tokens.ts";

describe("review round 1", () => {
	const row = (o: object) => JSON.stringify({ timestamp: "2026-11-10T10:00:00Z", ...o });
	const ask = (uuid: string, parentUuid: string | null, content: string) =>
		row({ type: "user", uuid, parentUuid, message: { content } });
	const reply = (uuid: string, parentUuid: string, id: string, cacheRead: number) =>
		row({
			type: "assistant",
			uuid,
			parentUuid,
			message: {
				id,
				model: "m",
				usage: {
					input_tokens: 1,
					cache_read_input_tokens: cacheRead,
					cache_creation_input_tokens: 0,
					output_tokens: 0,
				},
			},
		});

	test("a header word outside the known kinds, or quoted outside the wake envelope, never becomes a kind", async () => {
		expect(classifyPrompt("[chamberlain] private-project-name: hello")?.kind).toBe("wake");
		expect(classifyPrompt("Look at this:\n[chamberlain] answer: quoted from a thread")?.kind).toBe("message");
		expect(classifyPrompt('<command-args>x <webhook-data-ab12>[t3-wake] needs_input: thread "y"')?.kind).toBe(
			"needs_input",
		);
		const segs = await segmentTranscript([ask("u1", null, "[chamberlain] private-project-name: hi")], session);
		expect(JSON.stringify(segs)).not.toContain("private-project-name");
	});
	test("a prompt written while an earlier request runs takes none of that request's rows", async () => {
		const segs = await segmentTranscript(
			[
				ask("p1", null, "[chamberlain] answer: first"),
				reply("a1", "p1", "req-1", 100),
				// The second prompt is written before the first request's next row.
				ask("p2", "a1", "Second message"),
				reply("a2", "a1", "req-2", 200),
				reply("a3", "p2", "req-3", 300),
			],
			session,
		);
		expect(segs.map((s) => [s.kind, s.requests, s.cacheReadInputTokens])).toEqual([
			["answer", 2, 300],
			["message", 1, 300],
		]);
	});
	test("a later row of a request keeps the request's place, so context start and end stay in order", async () => {
		const segs = await segmentTranscript(
			[
				ask("p1", null, "[chamberlain] answer: x"),
				reply("a1", "p1", "A", 100),
				reply("a2", "a1", "B", 200),
				reply("a3", "a2", "A", 100),
			],
			session,
		);
		expect(segs[0]).toMatchObject({ requests: 2, contextStart: 101, contextEnd: 201 });
	});
	test("backfill arguments: files alone, --dir alone, and both", () => {
		expect(parseBackfillArgs(["a.jsonl"])).toEqual({ files: ["a.jsonl"] });
		expect(parseBackfillArgs(["a.jsonl", "b.jsonl"])).toEqual({ files: ["a.jsonl", "b.jsonl"] });
		expect(parseBackfillArgs(["--dir", "/x"])).toEqual({ dir: "/x", files: [] });
		expect(parseBackfillArgs(["a.jsonl", "--dir", "/x"])).toEqual({ dir: "/x", files: ["a.jsonl"] });
		expect(() => parseBackfillArgs(["--dir"])).toThrow();
		expect(() => parseBackfillArgs(["notes.txt"])).toThrow();
	});
	test("an earlier Steward's transcript whose read failed is retried next run, and the failure is reported", async () => {
		const d = mkdtempSync(join(tmpdir(), "chamberlain-tokens-"));
		const old = join(d, `${session}.jsonl`),
			next = join(d, "dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl");
		writeFileSync(old, fixtureText);
		writeFileSync(next, fixtureText.replaceAll(session, "dddddddd-dddd-dddd-dddd-dddddddddddd"));
		const store = memStore();
		let now = Date.parse("2026-11-10T12:00:00Z"),
			current = old;
		const tick = usageTicker({
			store,
			now: () => now,
			find: async () => ({
				path: current,
				session: "s",
				thread: "t",
			}),
		});
		await tick();
		// Make the old transcript unreadable (a directory where the file was), then hand off.
		const { renameSync, mkdirSync, rmSync } = await import("node:fs");
		renameSync(old, `${old}.bak`);
		mkdirSync(old);
		current = next;
		now += USAGE_INTERVAL_MS;
		await expect(tick()).rejects.toThrow(/could not read/);
		expect(store.state.get<{ retry?: string[] }>(USAGE_KEY)!.retry).toEqual([old]);
		rmSync(old, { recursive: true });
		renameSync(`${old}.bak`, old);
		now += USAGE_INTERVAL_MS;
		await tick();
		expect(store.state.get<{ retry?: string[] }>(USAGE_KEY)!.retry).toBeUndefined();
	});
});

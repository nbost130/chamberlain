import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memStore } from "../testing/store.ts";
import {
	backfill,
	classifyPrompt,
	findStewardTranscripts,
	formatUsage,
	parseBackfillArgs,
	percentile,
	segmentTranscript,
	totalTokens,
	USAGE_INTERVAL_MS,
	USAGE_KEY,
	usageReport,
	usageTicker,
	windowStats,
	type WakeUsage,
} from "./steward-tokens.ts";

// A synthetic transcript: every kind of turn-starting prompt, the rows that are not prompts, a request written as two rows, a sidechain,
// a synthetic reply, a compaction and a repeated delivery id. Its thread text carries markers that must never reach a report.
const session = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const fixtureText = readFileSync(new URL("./fixtures/steward-tokens.jsonl", import.meta.url), "utf8").replaceAll(
	"{{SESSION}}",
	session,
);
const fixture = fixtureText.trim().split("\n");
const segments = () => segmentTranscript(fixture, session);
const byKey = async (key: string) => (await segments()).find((s) => s.wakeKey === key)!;

describe("segmentation", () => {
	test("one segment per turn-starting prompt, in order; continuations, tool results and meta rows start none", async () => {
		const segs = await segments();
		expect(segs.map((s) => s.wakeKey)).toEqual([
			"uuid:u-start",
			"thread-1:ended:1:2",
			"uuid:u-wake-old",
			"sweep:1794000000000",
			"uuid:u-msg",
			"uuid:u-notice",
			"uuid:u-compact",
			"digest:0123456789abcdef",
			"thread-1:ended:1:2#2",
			"answer:item:Q-abc",
		]);
	});
	test("a request the model wrote as several rows counts once, with its last usage", async () => {
		const s = await byKey("uuid:u-start");
		expect(s.requests).toBe(1);
		expect(s.outputTokens).toBe(150);
		expect(s.cacheCreationInputTokens).toBe(40000);
	});
	test("calls before any prompt fall in a preamble segment", async () => {
		const row = JSON.stringify({
			type: "assistant",
			timestamp: "2026-11-10T09:00:00Z",
			message: { id: "m0", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 } },
		});
		const segs = await segmentTranscript([row], session);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({ wakeKey: "preamble", kind: "preamble", requests: 1, inputTokens: 5 });
	});
});

describe("labelling", () => {
	test("each wake's kind comes from its header, old (t3-wake) and new (chamberlain)", async () => {
		const kinds = Object.fromEntries((await segments()).map((s) => [s.wakeKey, s.kind]));
		expect(kinds).toEqual({
			"uuid:u-start": "start",
			"thread-1:ended:1:2": "turn_ended",
			"uuid:u-wake-old": "needs_input",
			"sweep:1794000000000": "sweep",
			"uuid:u-msg": "message",
			"uuid:u-notice": "notice",
			"uuid:u-compact": "compact",
			"digest:0123456789abcdef": "digest",
			"thread-1:ended:1:2#2": "turn_ended",
			"answer:item:Q-abc": "answer",
		});
	});
	test("a wake with a delivery id is keyed by it; a wake from before delivery ids by its row", async () => {
		expect((await byKey("thread-1:ended:1:2")).deliveryId).toBe("thread-1:ended:1:2");
		expect((await byKey("uuid:u-wake-old")).deliveryId).toBeUndefined();
		// A digest names its members' ids inside; its own id is the last line.
		expect((await byKey("digest:0123456789abcdef")).deliveryId).toBe("digest:0123456789abcdef");
	});
	test("a full sweep is told from a findings-only one", () => {
		expect(
			classifyPrompt("[chamberlain] sweep: time for a full supervision sweep, or a routine check could not run."),
		).toEqual({
			kind: "sweep",
			variant: "full",
		});
		expect(classifyPrompt("[chamberlain] sweep: the routine checks found the items below.")).toEqual({
			kind: "sweep",
			variant: "findings",
		});
	});
	test("a header deep in quoted text is not a wake", () => {
		expect(classifyPrompt(`${"x".repeat(3000)} [chamberlain] answer: quoted`)?.kind).toBe("message");
	});
	test("continuations are not prompts", () => {
		for (const t of [
			"<task-notification>\n<status>completed</status>",
			"Stop hook feedback:\nThe turn tried to end",
			"<local-command-stdout>Compacted </local-command-stdout>",
			"This session is being continued from a previous conversation that ran out of context.",
			"[Request interrupted by user]",
		])
			expect(classifyPrompt(t)).toBeUndefined();
	});
});

describe("sums", () => {
	test("a wake sums its distinct main-thread requests; sidechains, synthetic replies and request snapshots are not counted", async () => {
		const s = await byKey("thread-1:ended:1:2");
		expect(s).toMatchObject({
			requests: 3,
			inputTokens: 2 + 1 + 1,
			cacheReadInputTokens: 40000 + 40500 + 40800,
			cacheCreationInputTokens: 500 + 300 + 200,
			outputTokens: 50 + 80 + 40,
			contextStart: 2 + 40000 + 500,
			contextEnd: 1 + 40800 + 200,
			contextPeak: 1 + 40800 + 200,
		});
		expect(totalTokens(s)).toBe(4 + 121300 + 1000 + 170);
	});
	test("a compaction is counted in the segment it happened in, and the context starts small after it", async () => {
		expect((await byKey("uuid:u-compact")).compactions).toBe(1);
		expect((await byKey("uuid:u-compact")).contextStart).toBe(20002);
	});
	test("the whole transcript's requests are each counted exactly once", async () => {
		const segs = await segments();
		expect(segs.reduce((a, s) => a + s.requests, 0)).toBe(13);
	});
});

describe("storage and backfill", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "chamberlain-tokens-"));
	test("rows are stored keyed by (session, wake key) and read back whole", async () => {
		const store = memStore();
		const segs = await segments();
		store.usage.upsert(segs);
		expect(store.usage.list()).toEqual(segs);
		expect(store.usage.list({ session: "other" })).toEqual([]);
	});
	test("backfill is idempotent: a rerun writes the same rows, and a transcript that grew updates its last row in place", async () => {
		const d = dir(),
			path = join(d, `${session}.jsonl`);
		writeFileSync(path, fixtureText);
		const store = memStore();
		const first = await backfill(store, [path]);
		const rows = store.usage.list();
		expect(first).toMatchObject({ files: 1, sessions: [session], rows: 10, wakes: 6 });
		await backfill(store, [path]);
		expect(store.usage.list()).toEqual(rows);
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "assistant",
				timestamp: "2026-11-10T11:00:00Z",
				message: {
					id: "msg_14",
					model: "claude-test",
					usage: { input_tokens: 1, cache_read_input_tokens: 21500, output_tokens: 5 },
				},
			})}\n`,
		);
		await backfill(store, [path]);
		const after = store.usage.list();
		expect(after).toHaveLength(rows.length);
		expect(after.find((r) => r.wakeKey === "answer:item:Q-abc")!.requests).toBe(2);
	});
	test("the backfill finds Steward transcripts by their wakes and skips every other session in the folder", async () => {
		const d = dir();
		writeFileSync(join(d, `${session}.jsonl`), fixtureText);
		writeFileSync(
			join(d, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl"),
			`${JSON.stringify({ type: "user", uuid: "x", message: { content: "Build the thing. It mentions [chamberlain] in passing." } })}\n`,
		);
		writeFileSync(join(d, "notes.txt"), "[chamberlain] turn_ended:");
		expect(await findStewardTranscripts(d)).toEqual([join(d, `${session}.jsonl`)]);
	});
});

describe("the daemon's collector", () => {
	test("reads the current transcript hourly, and the previous one once more after a hand-off", async () => {
		const d = mkdtempSync(join(tmpdir(), "chamberlain-tokens-"));
		const old = join(d, `${session}.jsonl`),
			next = join(d, "cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl");
		writeFileSync(old, fixtureText);
		writeFileSync(next, fixtureText.replaceAll(session, "cccccccc-cccc-cccc-cccc-cccccccccccc"));
		const store = memStore();
		let now = Date.parse("2026-11-10T12:00:00Z"),
			current = old;
		const tick = usageTicker({
			store,
			now: () => now,
			find: async () => ({ path: current, session: current.slice(-42, -6), thread: "steward-thread" }),
		});
		await tick();
		expect(store.usage.list({ session })).toHaveLength(10);
		// The old session grows, then the Steward hands off before the next hourly run.
		appendFileSync(
			old,
			`${JSON.stringify({ type: "assistant", timestamp: "2026-11-10T11:30:00Z", message: { id: "late", model: "m", usage: { input_tokens: 1 } } })}\n`,
		);
		current = next;
		now += USAGE_INTERVAL_MS / 2;
		await tick();
		expect(store.usage.list({ session: "cccccccc-cccc-cccc-cccc-cccccccccccc" })).toHaveLength(0);
		now += USAGE_INTERVAL_MS;
		await tick();
		expect(store.usage.list({ session: "cccccccc-cccc-cccc-cccc-cccccccccccc" })).toHaveLength(10);
		expect(store.usage.list({ session }).find((r) => r.wakeKey === "answer:item:Q-abc")!.requests).toBe(2);
		expect(store.state.get<{ path: string }>(USAGE_KEY)!.path).toBe(next);
	});
});

describe("the report", () => {
	test("nearest-rank percentiles", () => {
		expect(percentile([], 50)).toBeUndefined();
		expect(percentile([5], 90)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
	});
	test("per kind, a full sweep's cost and the context trend, with no transcript text", async () => {
		const store = memStore();
		store.usage.upsert(await segments());
		const now = Date.parse("2026-11-10T12:00:00Z");
		const r = usageReport(store, { now, compactAt: 350_000 });
		const day = r.windows[0]!;
		expect(day.segments).toBe(10);
		expect(day.kinds.find((k) => k.kind === "turn_ended")).toMatchObject({ wakes: 2, requestsP50: 1, requestsP90: 3 });
		expect(day.fullSweep).toMatchObject({ wakes: 1, requestsP50: 2 });
		expect(day.sessions).toHaveLength(1);
		expect(day.sessions[0]).toMatchObject({ session, wakes: 6, contextPeak: 1 + 42500 + 50 });
		expect(r.text).toContain("A full sweep wake:");
		expect(r.text).toContain("Context trend");
		for (const secret of ["SECRET-THREAD-TEXT", "PRIVATE-PRINCIPAL-TEXT", "Alpha", "Why is this slow"])
			expect(r.text).not.toContain(secret);
		expect(JSON.stringify(r.windows)).not.toContain("SECRET-THREAD-TEXT");
	});
	test("a growing context projects the wakes left to the compaction line", () => {
		const rows: WakeUsage[] = [100_000, 150_000, 200_000].map((c, i) => ({
			session,
			wakeKey: `w${i}`,
			kind: "turn_ended",
			startedAt: 1000 + i,
			endedAt: 1000 + i,
			requests: 1,
			inputTokens: 0,
			cacheReadInputTokens: c,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			contextStart: c,
			compactions: 0,
		}));
		const w = windowStats(rows, "all", 0);
		expect(w.sessions[0]!.growthPerWake).toBe(50_000);
		expect(formatUsage([w], { compactAt: 350_000, now: 2000 })).toContain("about 3 wakes to the 350k compaction line");
	});
});

describe("review round 1", () => {
	const row = (o: object) => JSON.stringify({ timestamp: "2026-11-10T10:00:00Z", ...o });
	const ask = (uuid: string, parentUuid: string | null, content: string) =>
		row({ type: "user", uuid, parentUuid, message: { content } });
	const reply = (uuid: string, parentUuid: string, id: string, cacheRead: number) =>
		row({
			type: "assistant",
			uuid,
			parentUuid,
			message: { id, model: "m", usage: { input_tokens: 1, cache_read_input_tokens: cacheRead } },
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

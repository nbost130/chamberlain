/** classify, continued: see classify.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { NOW } from "../../testing/core-classifier-classify-fixtures.ts";
import { memStore } from "../../testing/store.ts";

describe("the disposition store (migration 13)", () => {
	const k = { server: "main", threadId: "a", messageHash: "h", bankVersion: "v1" };
	const row = {
		...k,
		classifiedAt: NOW,
		provider: "jev" as const,
		model: "jev-1.14.0",
		mode: "shadow" as const,
		action: "escalate" as const,
		reasons: ["asks_decision"],
		answers: { asks_decision: 0.98 },
		idleMinutes: 540,
		sentChars: 1900,
		redactions: 1,
		inputTokens: 1717,
		costUsd: 0.000072,
		latencyMs: 104,
		error: null,
	};
	test("put, get, and a replacement keeps feedback", () => {
		const s = memStore();
		s.dispositions.put(row);
		expect(s.dispositions.get(k)).toEqual({ ...row, feedback: null, correctedAction: null });
		expect(s.dispositions.feedback(k, "wrong", "settle")).toBe(true);
		s.dispositions.put({ ...row, classifiedAt: NOW + 1, action: "nudge" });
		expect(s.dispositions.get(k)).toMatchObject({
			action: "nudge",
			classifiedAt: NOW + 1,
			feedback: "wrong",
			correctedAction: "settle",
		});
		expect(s.dispositions.feedback({ ...k, threadId: "nope" }, "right")).toBe(false);
	});
	test("the table's checks: unknown exactly when an error is set; only known providers, modes, actions and feedback", () => {
		const s = memStore();
		expect(() => s.dispositions.put({ ...row, action: "unknown" })).toThrow();
		expect(() => s.dispositions.put({ ...row, error: "boom" })).toThrow();
		expect(() => s.dispositions.put({ ...row, provider: "gpt" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, mode: "loud" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, action: "panic" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, sentChars: -1 })).toThrow();
		s.dispositions.put(row);
		expect(() => s.dispositions.feedback(k, "maybe" as never)).toThrow();
		expect(() => s.dispositions.feedback(k, "wrong", "unknown" as never)).toThrow();
		s.dispositions.put({
			...row,
			threadId: "b",
			action: "unknown",
			error: "Jev answered HTTP 503",
			answers: {},
			reasons: [],
		});
	});
	test("redecide changes only the decision of a classified row, never an unknown one", () => {
		const s = memStore();
		s.dispositions.put(row);
		s.dispositions.redecide(k, { action: "ignore", reasons: ["claims_armed_wait"], idleMinutes: 600, mode: "live" });
		expect(s.dispositions.get(k)).toMatchObject({
			action: "ignore",
			reasons: ["claims_armed_wait"],
			idleMinutes: 600,
			mode: "live",
			classifiedAt: NOW,
		});
		const u = { ...k, threadId: "u" };
		s.dispositions.put({ ...row, ...u, action: "unknown", error: "x", reasons: [], answers: {} });
		s.dispositions.redecide(u, { action: "settle", reasons: [], idleMinutes: 1, mode: "live" });
		expect(s.dispositions.get(u)!.action).toBe("unknown");
	});
	test("usage counts the day's calls and spend per provider", () => {
		const s = memStore();
		s.dispositions.put(row);
		s.dispositions.put({ ...row, threadId: "b", costUsd: 0.5 });
		s.dispositions.put({ ...row, threadId: "c", provider: "haiku", costUsd: null });
		s.dispositions.put({ ...row, threadId: "old", classifiedAt: NOW - 86_400_000 });
		expect(s.dispositions.usage(NOW - 1000, ["jev"])).toEqual({ calls: 2, usd: 0.500072 });
		expect(s.dispositions.usage(NOW - 1000, ["jev", "haiku"]).calls).toBe(3);
		expect(s.dispositions.usage(NOW - 1000, [])).toEqual({ calls: 0, usd: 0 });
	});
	test("prune deletes old rows and keeps the ones with feedback (the next evaluation set)", () => {
		const s = memStore();
		s.dispositions.put({ ...row, threadId: "old", classifiedAt: NOW - 40 * 86_400_000 });
		s.dispositions.put({ ...row, threadId: "kept", classifiedAt: NOW - 40 * 86_400_000 });
		s.dispositions.feedback({ ...k, threadId: "kept" }, "right");
		s.dispositions.put(row);
		expect(s.dispositions.prune(NOW - 30 * 86_400_000)).toBe(1);
		expect(s.dispositions.get({ ...k, threadId: "old" })).toBeUndefined();
		expect(s.dispositions.get({ ...k, threadId: "kept" })).toBeDefined();
		expect(s.dispositions.get(k)).toBeDefined();
	});
	test("the table has no column that could hold message text", async () => {
		const { MIGRATIONS } = await import("../store/migrations.ts");
		const sql = MIGRATIONS.find((m) => m.version === 13)!.sql;
		const body = sql.slice(sql.indexOf("CREATE TABLE thread_dispositions ("), sql.indexOf("PRIMARY KEY"));
		const columns = [...body.matchAll(/^\t(\w+) (TEXT|INTEGER|REAL)/gm)].map((m) => m[1]);
		expect(columns).toEqual([
			"server",
			"thread_id",
			"message_hash",
			"bank_version",
			"classified_at",
			"provider",
			"model",
			"mode",
			"action",
			"reasons",
			"answers",
			"idle_minutes",
			"sent_chars",
			"redactions",
			"input_tokens",
			"cost_usd",
			"latency_ms",
			"error",
			"feedback",
			"corrected_action",
		]);
	});
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContextGuard } from "../../core/config/context-guard.ts";
import { guardedHealth } from "../../core/steward/steward-health.ts";
import { segmentTranscript } from "../../core/steward/steward-segments.ts";
import { totalTokens, turnUsageTicker } from "../../core/steward/steward-tokens.ts";
import { memStore } from "../../testing/store.ts";
import { t3Meter } from "./meter.ts";
import { renderFencedWake } from "./receipts.ts";

const START = "2030-01-01T12:00:01.000Z";
const END = "2030-01-01T12:00:05.000Z";
const before = Date.parse(START) - 1000;
const base = "orchestration_v2_projection_";
const current = { tokens: 75_000, window: 150_000, at: END, source: "provider turn" } as const;
const deliver = "synthetic-delivery";
const complete = {
	usageStatus: "complete",
	usageScope: "main_agent",
	inputTokens: 100,
	cacheCreationTokens: 20,
	cachedInputTokens: 30,
	outputTokens: 40,
	reasoningTokens: 12,
};

function projection(db: Database, bare = false) {
	db.exec(`
		CREATE TABLE ${base}threads (thread_id, active_provider_thread_id);
		CREATE TABLE ${base}provider_threads (provider_thread_id, thread_id, driver, payload_json);
		CREATE TABLE ${base}provider_turns (provider_turn_id, provider_thread_id, thread_id, ordinal, run_attempt_id, started_at, completed_at, payload_json);
		CREATE TABLE ${base}run_attempts (attempt_id, thread_id, run_id, provider_instance_id, payload_json);
		CREATE TABLE ${base}runs (run_id, thread_id, provider_instance_id, requested_at, payload_json);
		CREATE TABLE ${base}messages (message_id, thread_id, role, payload_json);
		CREATE TABLE ${base}turn_items (provider_turn_id, thread_id, ordinal, type, status, payload_json);
		INSERT INTO ${base}threads VALUES ('fixture-thread', 'fixture-provider');
		INSERT INTO ${base}run_attempts VALUES ('fixture-attempt', 'fixture-thread', 'fixture-run', 'fixture-instance', '{}');
	`);
	const message = "scheduled-task-message:fixture:webhook:delivery:fixture";
	const body = "[chamberlain] sweep: time for a full supervision sweep";
	db.run(`INSERT INTO ${base}runs VALUES ('fixture-run', 'fixture-thread', 'fixture-instance', ?, ?)`, [
		new Date(before).toISOString(),
		JSON.stringify({ userMessageId: message, modelSelection: { model: "fixture-model" } }),
	]);
	db.run(`INSERT INTO ${base}messages VALUES (?, 'fixture-thread', 'user', ?)`, [
		message,
		JSON.stringify({
			scheduledTaskId: "fixture",
			text: renderFencedWake(bare ? body : `<webhook-data-abc>${body}</webhook-data-abc>`, deliver, "abc"),
		}),
	]);
}

function turn(db: Database, driver: string, session = "fixture-provider", usage: unknown = complete) {
	db.run(`INSERT INTO ${base}provider_threads VALUES (?, 'fixture-thread', ?, ?)`, [
		session,
		driver,
		JSON.stringify({ nativeThreadRef: { nativeId: "fixture-native" } }),
	]);
	db.run(`INSERT INTO ${base}provider_turns VALUES (?, ?, 'fixture-thread', 1, 'fixture-attempt', ?, ?, ?)`, [
		session,
		session,
		START,
		END,
		JSON.stringify({ turnTokenUsage: usage, tokenUsage: { usedTokens: 999_999 } }),
	]);
	for (let i = 0; i < 5; i++) {
		const args =
			driver === "codex"
				? { input: "chamberlain debug peek local sample-thread" }
				: { toolName: "mcp__t3_code__t3_thread_read", input: { threadId: "sample-thread" } };
		db.run(`INSERT INTO ${base}turn_items VALUES (?, 'fixture-thread', ?, ?, 'completed', ?)`, [
			session,
			i,
			driver === "codex" ? "command_execution" : "dynamic_tool",
			JSON.stringify({ startedAt: START, ...args }),
		]);
	}
}

async function fixture(run: (db: Database, path: string) => void | Promise<void>, bare = false) {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-meter-"));
	try {
		const path = join(dir, "state.sqlite");
		using db = new Database(path);
		projection(db, bare);
		await run(db, path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test.each(["claudeAgent", "cursor", "codex", "antigravity", "grok"])(
	"%s produces the same wake row and verdict from equivalent records",
	(driver) =>
		fixture(async (db, path) => {
			turn(db, driver);
			const store = memStore();
			const meter = t3Meter(path, "fixture-thread", before, true);
			const tick = turnUsageTicker({
				store,
				thread: () => "fixture-thread",
				read: () => meter,
				now: () => Date.parse(END),
			});
			tick();
			tick();
			const rows = store.usage.list();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				session: "fixture-provider",
				wakeKey: "1",
				source: "turn record",
				kind: "sweep",
				variant: "full",
				deliveryId: deliver,
				model: "fixture-model",
				startedAt: Date.parse(START),
				endedAt: Date.parse(END),
				inputTokens: 50,
				cacheReadInputTokens: 30,
				cacheCreationInputTokens: 20,
				outputTokens: 40,
				reasoningTokens: 12,
				toolCalls: 5,
				threadReads: 5,
			});
			expect(rows[0]?.requests).toBeUndefined();
			const health = await guardedHealth({
				meter,
				probe: { readable: true, context: current },
				policy: parseContextGuard(undefined),
				find: async () => {
					throw Error("no native transcript expected");
				},
			});
			// The limit hands off only where both kinds of reread are measured; elsewhere it is watched.
			expect(health.verdict).toBe(driver === "claudeAgent" ? "HAND OFF" : "WATCH");
			expect(health.elevated).toEqual(["rereading"]);
			expect(health.threadRereads).toBe(4);
			if (driver !== "claudeAgent") expect(health.report).toContain("not measured self-transcript reads");
			store.close();
		}, driver === "cursor"),
);

test("ordinal restarts coexist; absent usage and changed schema are explicit", () =>
	fixture(async (db, path) => {
		turn(db, "claudeAgent", "retired");
		turn(db, "grok", "fixture-provider", null);
		db.run(`DELETE FROM ${base}turn_items WHERE provider_turn_id = 'fixture-provider'`);
		const measured = t3Meter(path, "fixture-thread", before, true);
		if (!("rows" in measured)) throw Error(measured.unknown);
		expect(measured.rows.map((r) => [r.session, r.wakeKey])).toEqual([
			["retired", "1"],
			["fixture-provider", "1"],
		]);
		const missing = measured.rows[1];
		expect(missing).toMatchObject({ unknown: "turn tokens unavailable", toolCalls: 0 });
		expect(missing).not.toHaveProperty("inputTokens");
		expect(
			(
				await guardedHealth({
					meter: measured,
					probe: { readable: true, context: current },
					policy: parseContextGuard(undefined),
				})
			).verdict,
		).toBe("OK");
		db.run(`ALTER TABLE ${base}turn_items RENAME TO changed`);
		expect(t3Meter(path, "fixture-thread", before)).toEqual({ unknown: "turn records unavailable" });
	}));

test("the same turn through native detail and projection yields one billable row in either write order", () =>
	fixture(async (db, path) => {
		turn(db, "claudeAgent");
		const meter = t3Meter(path, "fixture-thread", before);
		if (!("rows" in meter)) throw Error(meter.unknown);
		const text = `[chamberlain] sweep: time for a full supervision sweep\ndelivery id: ${deliver} (the same id again is a repeat`;
		const history = await segmentTranscript(
			[
				JSON.stringify({ type: "user", uuid: "fixture-prompt", timestamp: START, message: { content: text } }),
				JSON.stringify({
					type: "assistant",
					uuid: "fixture-answer",
					parentUuid: "fixture-prompt",
					timestamp: END,
					message: {
						id: "fixture-request",
						model: "fixture-model",
						usage: {
							input_tokens: 50,
							cache_read_input_tokens: 30,
							cache_creation_input_tokens: 20,
							output_tokens: 40,
						},
					},
				}),
			],
			"fixture-native",
		);
		expect(history.map(totalTokens)).toEqual(meter.rows.map(totalTokens));
		for (const sources of [
			[history, meter.rows],
			[meter.rows, history],
		]) {
			const store = memStore();
			for (const rows of sources) store.usage.upsert(rows);
			expect(store.usage.list().map((r) => [r.source, totalTokens(r)])).toEqual([["turn record", 140]]);
			expect(store.usage.list({ transcriptOnly: true })).toMatchObject([{ source: "transcript", requests: 1 }]);
			store.close();
		}
	}));

test("automatic compaction inside a wake keeps its delivery and resets quality history", () =>
	fixture((db, path) => {
		turn(db, "cursor");
		db.run(
			`INSERT INTO ${base}turn_items VALUES ('fixture-provider', 'fixture-thread', 10, 'compaction', 'completed', '{}')`,
		);
		expect(t3Meter(path, "fixture-thread", before, true)).toMatchObject({
			rows: [{ kind: "sweep", deliveryId: deliver, compactions: 1 }],
			quality: { threadRereads: 0, boundary: END },
		});
	}));

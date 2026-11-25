import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFencedWake } from "./receipts.ts";

export const START = "2030-01-01T12:00:01.000Z";
export const END = "2030-01-01T12:00:05.000Z";
export const before = Date.parse(START) - 1000;
export const base = "orchestration_v2_projection_";
export const deliver = "synthetic-delivery";
export const complete = {
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

export function turn(db: Database, driver: string, session = "fixture-provider", usage: unknown = complete) {
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
		JSON.stringify({ executedModel: "fixture-model", turnTokenUsage: usage, tokenUsage: { usedTokens: 999_999 } }),
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

export async function fixture(run: (db: Database, path: string) => void | Promise<void>, bare = false) {
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

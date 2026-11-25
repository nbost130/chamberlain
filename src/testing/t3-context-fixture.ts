import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A T3 state database with only the Steward's provider turns, each `[ordinal, usedTokens | null]`, and its completed compaction items, each
 * the ordinal of the provider turn that ran it (T3 stores a compaction as a `compaction` turn item on its turn).
 */
const STARTED = new Date(Date.now() - 60_000).toISOString();
export const COMPLETED = new Date(Date.now() - 1_000).toISOString();

export function t3Db(turns: [number, number | null][] = [], compactionsOn: number[] = []): string {
	const path = join(mkdtempSync(join(tmpdir(), "steward-probe-")), "state.sqlite");
	const db = new Database(path);
	db.run(
		"create table orchestration_v2_projection_provider_turns (provider_turn_id text, thread_id text, provider_thread_id text, ordinal integer, status text, started_at text, completed_at text, payload_json text)",
	);
	db.run(
		"create table orchestration_v2_projection_turn_items (turn_item_id text, thread_id text, provider_turn_id text, provider_thread_id text, ordinal integer, type text, status text, payload_json text)",
	);
	db.run("create table orchestration_v2_projection_threads (thread_id text, active_provider_thread_id text)");
	db.run("create table orchestration_v2_projection_provider_threads (provider_thread_id text, payload_json text)");
	db.run("insert into orchestration_v2_projection_threads values ('th', 'primary')");
	provider(db, "primary", "claudeAgent");
	for (const [ordinal, used] of turns)
		turn(db, "primary", ordinal, { payload: used === null ? {} : usage(used), complete: used !== null });
	for (const [i, turn] of compactionsOn.entries())
		db.run("insert into orchestration_v2_projection_turn_items values (?, ?, ?, ?, ?, ?, ?, ?)", [
			`c${i}`,
			"th",
			`primary-${turn}`,
			"primary",
			turn * 1000,
			"compaction",
			"completed",
			"{}",
		]);
	db.close();
	return path;
}

export function provider(db: Database, session: string, driver: string, extra = {}) {
	db.run("insert into orchestration_v2_projection_provider_threads values (?, ?)", [
		session,
		JSON.stringify({ driver, ...extra }),
	]);
}

export function turn(
	db: Database,
	session: string,
	ordinal: number,
	{ payload, complete = true }: { payload: object; complete?: boolean },
) {
	db.run("insert into orchestration_v2_projection_provider_turns values (?, 'th', ?, ?, ?, ?, ?, ?)", [
		`${session}-${ordinal}`,
		session,
		ordinal,
		complete ? "completed" : "running",
		STARTED,
		complete ? COMPLETED : null,
		JSON.stringify(payload),
	]);
}

export const usage = (usedTokens: unknown, maxTokens?: number, updatedAt = COMPLETED) => ({
	tokenUsage: { usedTokens, maxTokens, updatedAt },
});

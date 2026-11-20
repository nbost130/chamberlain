import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t3Probe } from "./steward.ts";

/**
 * A T3 state database with only the Steward's provider turns, each `[ordinal, usedTokens | null]`, and its completed compaction items, each
 * the ordinal of the provider turn that ran it (T3 stores a compaction as a `compaction` turn item on its turn).
 */
function t3Db(turns: [number, number | null][], compactionsOn: number[] = []): string {
	const path = join(mkdtempSync(join(tmpdir(), "steward-probe-")), "state.sqlite");
	const db = new Database(path);
	db.run(
		"create table orchestration_v2_projection_provider_turns (provider_turn_id text, thread_id text, ordinal integer, payload_json text)",
	);
	db.run(
		"create table orchestration_v2_projection_turn_items (turn_item_id text, thread_id text, provider_turn_id text, ordinal integer, type text, status text, payload_json text)",
	);
	for (const [ordinal, used] of turns)
		db.run("insert into orchestration_v2_projection_provider_turns values (?, ?, ?, ?)", [
			`pt${ordinal}`,
			"th",
			ordinal,
			JSON.stringify(used === null ? { status: "running" } : { tokenUsage: { usedTokens: used } }),
		]);
	for (const [i, turn] of compactionsOn.entries())
		db.run("insert into orchestration_v2_projection_turn_items values (?, ?, ?, ?, ?, ?, ?)", [
			`c${i}`,
			"th",
			`pt${turn}`,
			turn * 1000,
			"compaction",
			"completed",
			"{}",
		]);
	db.close();
	return path;
}

test("the context size is the newest turn's, and which turn that is", () => {
	const p = t3Probe(
		t3Db([
			[1, 80_000],
			[2, 120_000],
		]),
		"th",
	);
	expect(p.contextTokens).toBe(120_000);
	expect(p.contextTurn).toBe(2);
});

test("a turn that has just begun and has no usage yet gives NO size, never an older turn's sample", () => {
	// After a native or manual compaction the newest turn has no usage yet; an older turn's 120k would still read as the large pre-compaction
	// size.
	const p = t3Probe(
		t3Db([
			[1, 80_000],
			[2, 120_000],
			[3, null],
		]),
		"th",
	);
	expect(p.contextTokens).toBeUndefined();
	expect(p.contextTurn).toBe(3);
});

test("no turn with a size is no size, never zero", () => {
	expect(t3Probe(t3Db([[1, null]]), "th").contextTokens).toBeUndefined();
	expect(t3Probe(t3Db([]), "th").contextTokens).toBeUndefined();
});

test("compactions are counted from T3's compaction items (the daemon's, native and manual alike), with the turn that ran the newest", () => {
	const none = t3Probe(t3Db([[1, 200_000]]), "th");
	expect(none.compactions).toBe(0);
	expect(none.compactionTurn).toBeUndefined();
	const two = t3Probe(
		t3Db(
			[
				[1, 200_000],
				[2, 10_000],
				[3, 90_000],
				[4, 12_000],
			],
			[2, 4],
		),
		"th",
	);
	expect(two.compactions).toBe(2);
	expect(two.compactionTurn).toBe(4);
	// That turn's own size is the size after the compaction.
	expect(two.contextTokens).toBe(12_000);
	expect(two.contextTurn).toBe(4);
});

test("a database that cannot be read gives no compaction count: no evidence, which is not evidence of none", () => {
	const p = t3Probe("/nonexistent/statev2.sqlite", "th");
	expect(p.compactions).toBeUndefined();
	expect(p.contextTokens).toBeUndefined();
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t3Probe } from "./steward.ts";

/** A T3 state database with only the Steward's provider turns, each `[ordinal, usedTokens | null]`. */
function t3Db(turns: [number, number | null][]): string {
	const path = join(mkdtempSync(join(tmpdir(), "steward-probe-")), "state.sqlite");
	const db = new Database(path);
	db.run(
		"create table orchestration_v2_projection_provider_turns (thread_id text, ordinal integer, payload_json text)",
	);
	for (const [ordinal, used] of turns)
		db.run("insert into orchestration_v2_projection_provider_turns values (?, ?, ?)", [
			"th",
			ordinal,
			JSON.stringify(used === null ? { status: "running" } : { tokenUsage: { usedTokens: used } }),
		]);
	db.close();
	return path;
}

test("the context size is the newest turn's", () => {
	expect(
		t3Probe(
			t3Db([
				[1, 80_000],
				[2, 120_000],
			]),
			"th",
		).contextTokens,
	).toBe(120_000);
});

test("a turn that has just begun and has no usage yet does not hide the size: the newest turn WITH one is read", () => {
	// Reading only the newest row gave no size for the first minutes of every wake, and the missing size used to drop the rights record.
	expect(
		t3Probe(
			t3Db([
				[1, 80_000],
				[2, 120_000],
				[3, null],
			]),
			"th",
		).contextTokens,
	).toBe(120_000);
});

test("no turn with a size is no size, never zero", () => {
	expect(t3Probe(t3Db([[1, null]]), "th").contextTokens).toBeUndefined();
	expect(t3Probe(t3Db([]), "th").contextTokens).toBeUndefined();
});

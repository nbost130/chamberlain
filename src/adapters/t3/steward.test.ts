import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { COMPLETED, provider, t3Db, turn, usage } from "../../testing/t3-context-fixture.ts";
import { t3Probe } from "./steward.ts";

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
	expect(p).toMatchObject({ contextPending: true, lastMeasuredContext: { tokens: 120_000, at: COMPLETED } });
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
	expect(p.context).toMatchObject({ unknown: expect.any(String) });
});

test("a provider switch resets ordinal ordering and compaction evidence", () => {
	const path = t3Db([[308, 380_000]], [308]);
	const db = new Database(path);
	provider(db, "replacement", "cursor");
	db.run("update orchestration_v2_projection_threads set active_provider_thread_id = 'replacement'");
	turn(db, "replacement", 1, { payload: usage(12_000, 256_000) });
	expect(t3Probe(path, "th")).toMatchObject({ contextTokens: 12_000, contextTurn: 1, compactions: 0 });
	expect(t3Probe(path, "th").compactionTurn).toBeUndefined();
	turn(db, "replacement", 2, { payload: {} });
	const p = t3Probe(path, "th");
	expect(p.context).toMatchObject({ unknown: expect.any(String) });
	expect(p.contextTokens).toBeUndefined();
	expect(p.unknownTurns).toEqual([2]);
	db.close();
});

test.each(["claudeAgent", "codex", "cursor", "grok", "antigravity"])(
	"%s uses only a current projected size",
	(driver) => {
		const path = t3Db();
		const db = new Database(path);
		db.run("delete from orchestration_v2_projection_provider_threads");
		provider(db, "primary", driver);
		turn(db, "primary", 1, { payload: usage(75_000, 100_000) });
		expect(t3Probe(path, "th").context).toEqual({
			tokens: 75_000,
			window: 100_000,
			at: COMPLETED,
			source: "provider turn",
		});
		turn(db, "primary", 2, {
			payload: { turnTokenUsage: { inputTokens: 250_000 }, tokenUsage: { inputTokens: 50_000 } },
		});
		expect(t3Probe(path, "th").context).toMatchObject({ unknown: expect.any(String) });
		turn(db, "primary", 3, { payload: usage(150_000, 100_000) });
		expect(t3Probe(path, "th").context).toMatchObject({ unknown: expect.any(String) });
		turn(db, "primary", 4, { payload: usage(75_000, 100_000, "2000-01-01T00:00:00.000Z") });
		expect(t3Probe(path, "th").context).toMatchObject({ unknown: expect.any(String) });
		turn(db, "primary", 5, { payload: usage("75000", 100_000) });
		expect(t3Probe(path, "th").context).toMatchObject({ unknown: expect.any(String) });
		db.close();
	},
);

test("an explicit compaction refusal only applies to its active provider thread", () => {
	const path = t3Db([[1, 145_000]]);
	const db = new Database(path);
	const payload = {
		failure: {
			message: "This provider does not support /compact. Start a new thread to continue with a fresh context.",
		},
	};
	db.run(
		"insert into orchestration_v2_projection_turn_items values ('err', 'th', null, 'previous', 1, 'error', 'failed', ?)",
		[JSON.stringify(payload)],
	);
	expect(t3Probe(path, "th").canCompact).toBe(true);
	db.run("update orchestration_v2_projection_turn_items set provider_thread_id = 'primary'");
	expect(t3Probe(path, "th")).toMatchObject({ canCompact: false, contextTokens: 145_000 });
	db.close();
});

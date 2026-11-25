import { expect, test } from "bun:test";
import { parseContextGuard } from "../../core/config/context-guard.ts";
import { guardedHealth } from "../../core/steward/steward-health.ts";
import { segmentTranscript } from "../../core/steward/steward-segments.ts";
import { totalTokens, turnUsageTicker } from "../../core/steward/steward-tokens.ts";
import { memStore } from "../../testing/store.ts";
import { t3Meter } from "./meter.ts";
import { base, before, complete, deliver, END, fixture, START, turn } from "./meter-fixture.test.ts";

const current = { tokens: 75_000, window: 150_000, at: END, source: "provider turn" } as const;

test("a direct hand-off command exempts its own transcript reads", () =>
	fixture(async (db, path) => {
		turn(db, "claudeAgent");
		db.run(`UPDATE ${base}messages SET payload_json = '{"text":"/steward-handoff"}'`);
		db.run(`DELETE FROM ${base}turn_items`);
		for (let ordinal = 0; ordinal < 3; ordinal++)
			db.run(
				`INSERT INTO ${base}turn_items VALUES ('fixture-provider', 'fixture-thread', ?, 'command_execution', 'completed', ?)`,
				[ordinal, JSON.stringify({ startedAt: START, input: "head fixture-native.jsonl" })],
			);
		const meter = t3Meter(path, "fixture-thread", before, true);
		const health = await guardedHealth({
			meter,
			probe: { readable: true, context: current },
			policy: parseContextGuard(undefined),
		});
		expect(health).toMatchObject({ selfReads: 0, verdict: "OK" });
	}));

test("a compaction beyond the tool cap still resets reread quality", () =>
	fixture(async (db, path) => {
		turn(db, "claudeAgent");
		db.run(`WITH RECURSIVE seq(n) AS (SELECT 5 UNION ALL SELECT n + 1 FROM seq WHERE n < 2049)
			INSERT INTO ${base}turn_items SELECT 'fixture-provider', 'fixture-thread', n, 'command_execution', 'completed', '{"input":"pwd"}' FROM seq`);
		db.run(
			`INSERT INTO ${base}turn_items VALUES ('fixture-provider', 'fixture-thread', 2050, 'compaction', 'completed', '{}')`,
		);
		const meter = t3Meter(path, "fixture-thread", before, true);
		expect(meter).toMatchObject({ rows: [{ compactions: 1 }], quality: { threadRereads: 0, boundary: END } });
		const health = await guardedHealth({
			meter,
			probe: { readable: true, context: current },
			policy: parseContextGuard(undefined),
		});
		expect(health.verdict).not.toBe("HAND OFF");
	}));

test("a requested model is not execution evidence", () =>
	fixture((db, path) => {
		turn(db, "cursor");
		db.run(`UPDATE ${base}provider_turns SET payload_json = json_remove(payload_json, '$.executedModel')`);
		const meter = t3Meter(path, "fixture-thread", before);
		if (!("rows" in meter)) throw Error(meter.unknown);
		expect(meter.rows).toHaveLength(1);
		expect(meter.rows[0]).not.toHaveProperty("model");
	}));

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

test("inconsistent cache counters omit uncached input and a copied wake envelope has no delivery id", () =>
	fixture((db, path) => {
		turn(db, "cursor", "fixture-provider", { ...complete, inputTokens: 49 });
		db.run(`UPDATE ${base}messages SET payload_json = json_remove(payload_json, '$.scheduledTaskId')`);
		const measured = t3Meter(path, "fixture-thread", before);
		if (!("rows" in measured)) throw Error(measured.unknown);
		const [row] = measured.rows;
		expect(row).toMatchObject({
			kind: "message",
			tokensIncomplete: true,
			unknown: "turn token fields incomplete",
			cacheReadInputTokens: 30,
			cacheCreationInputTokens: 20,
		});
		expect(row).not.toHaveProperty("inputTokens");
		expect(row).not.toHaveProperty("deliveryId");
	}));

test("per-turn and batch item bounds never turn partial counts into observations", () =>
	fixture((db, path) => {
		turn(db, "cursor");
		db.run(`DELETE FROM ${base}turn_items`);
		for (const [index, count] of [2049, 2048, 2048, 2048, 2048, 1760, 1].entries()) {
			const id = `batch-${index}`;
			db.run(
				`INSERT INTO ${base}provider_turns SELECT ?, provider_thread_id, thread_id, ?, run_attempt_id, ?, completed_at, payload_json FROM ${base}provider_turns WHERE provider_turn_id = 'fixture-provider'`,
				[id, index + 2, new Date(Date.parse(START) - index - 1).toISOString()],
			);
			db.run(
				`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
				INSERT INTO ${base}turn_items SELECT ?, 'fixture-thread', n, 'command_execution', 'completed', ? FROM seq`,
				[count, id, JSON.stringify({ startedAt: START, input: "chamberlain debug peek local sample-thread" })],
			);
		}
		const measured = t3Meter(path, "fixture-thread", before);
		if (!("rows" in measured)) throw Error(measured.unknown);
		const byKey = new Map(measured.rows.map((row) => [row.wakeKey, row]));
		for (const key of ["2", "7", "8"]) {
			const row = byKey.get(key);
			expect(row?.unknown).toContain("tool fields incomplete");
			expect(row).not.toHaveProperty("toolCalls");
			expect(row).not.toHaveProperty("threadReads");
		}
		expect(byKey.get("3")).toMatchObject({ toolCalls: 2048, threadReads: 2048 });
	}));

test("repeat reads honor the ten-minute boundary and own-delivery lookups do not count as self-reads", () =>
	fixture((db, path) => {
		turn(db, "claudeAgent");
		db.run(`DELETE FROM ${base}turn_items`);
		for (const [index, offset] of [0, 600_000, 1_200_001].entries())
			db.run(
				`INSERT INTO ${base}turn_items VALUES ('fixture-provider', 'fixture-thread', ?, 'dynamic_tool', 'completed', ?)`,
				[
					index,
					JSON.stringify({
						startedAt: new Date(Date.parse(START) + offset).toISOString(),
						toolName: "t3_thread_read",
						input: { threadId: "sample-thread" },
					}),
				],
			);
		for (const [index, input] of [`rg ${deliver} fixture-native.jsonl`, "head fixture-native.jsonl"].entries())
			db.run(
				`INSERT INTO ${base}turn_items VALUES ('fixture-provider', 'fixture-thread', ?, 'command_execution', 'completed', ?)`,
				[index + 3, JSON.stringify({ startedAt: START, input })],
			);
		db.run(`UPDATE ${base}provider_turns SET completed_at = '2030-01-01T12:21:00.000Z'`);
		expect(t3Meter(path, "fixture-thread", before, true)).toMatchObject({
			rows: [{ toolCalls: 5, threadReads: 3, deliveryId: deliver }],
			quality: { threadRereads: 1, selfReads: 1 },
		});
	}));

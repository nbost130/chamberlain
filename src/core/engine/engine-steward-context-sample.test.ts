import { afterEach, expect, setSystemTime, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { readHealth } from "../steward/steward-health.ts";
import { createEngine } from "./engine.ts";
import { COMPACT_STATE_KEY } from "./engine-steward.ts";

const { rig } = useCoreEngineFixtures(createEngine);
const STEWARD = "steward-test";
const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const MIN = 60_000;
afterEach(() => setSystemTime());

test.each([
	[365_000, 65_000],
	[352_000, 50_000],
	[365_000, 370_000],
	[345_000, 370_000],
])("a compaction sampled at %i waits for the next turn's %i tokens", async (before, after) => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "stewardMeter", "handoffInstruction"] });
	adapter.stewardMeter = () => ({ rows: [], quality: { threadRereads: 0 } });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true, compactAt: 350_000 });
	setSystemTime(NOW);
	r.store.state.set(COMPACT_STATE_KEY, {
		thread: STEWARD,
		session: "session",
		at: NOW - 11 * MIN,
		used: 365_000,
		cleared: false,
		compactions: 4,
	});
	const probe = (turn: number, tokens: number) => ({
		readable: true,
		contextSession: "session",
		contextTurn: turn,
		completedTurn: turn,
		context: { tokens, at: new Date(Date.now()).toISOString(), source: "fixture", beforeTurnEffects: true as const },
		contextTokens: tokens,
		compactions: 5,
		compactionTurn: 11,
		retryLostCompact: false,
	});
	adapter.probe = probe(11, before);
	await r.engine.tick();
	expect(r.store.state.get(COMPACT_STATE_KEY)).toMatchObject({ cleared: false });
	expect(r.store.state.get(COMPACT_STATE_KEY)).not.toHaveProperty("failed", true);
	expect(r.store.wakes.find("steward-handoff:session")).toBeUndefined();

	setSystemTime(NOW + 61 * MIN);
	adapter.probe = probe(12, after);
	await r.engine.tick();
	if (after > 350_000) {
		expect(r.store.state.get(COMPACT_STATE_KEY)).toMatchObject({ failed: true });
		expect(readHealth(r.store)?.verdict).toBe("HAND OFF");
	} else {
		expect(r.store.state.get(COMPACT_STATE_KEY)).toMatchObject({ cleared: true });
		expect(r.store.wakes.find("steward-handoff:session")).toBeUndefined();
	}
});

test("a low running sample after a completed compaction does not persist a failure", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "stewardMeter", "handoffInstruction"] });
	adapter.stewardMeter = () => ({ rows: [], quality: { threadRereads: 0 } });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true, compactAt: 100 });
	setSystemTime(NOW);
	r.store.state.set(COMPACT_STATE_KEY, {
		thread: STEWARD,
		session: "session",
		at: NOW - 31 * MIN,
		used: 180,
		cleared: false,
		compactions: 4,
	});
	adapter.probe = {
		readable: true,
		contextSession: "session",
		contextPending: true,
		contextTurn: 12,
		context: { tokens: 40, at: AT, source: "fixture" },
		contextTokens: 40,
		compactions: 5,
		compactionTurn: 11,
		retryLostCompact: false,
	};
	await r.engine.tick();
	expect(r.store.state.get(COMPACT_STATE_KEY)).not.toHaveProperty("failed", true);
	expect(readHealth(r.store)?.verdict).toBe("OK");
	expect(r.store.wakes.find("steward-handoff:session")).toBeUndefined();
});

test("completed unknown turns still alarm when every poll finds the next turn running", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe"] });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true });
	for (let completed = 1; completed <= 29; completed++) {
		adapter.probe = {
			readable: true,
			contextSession: "session",
			contextPending: true,
			contextTurn: completed + 1,
			completedTurn: completed,
			previousCompletedTurn: completed - 1,
			context: { unknown: "running" },
			unknownTurns: Array.from({ length: completed }, (_, i) => completed - i),
		};
		await r.engine.tick();
		const alarms = r.events.filter((e) => e.event === "alarm" && String(e.key).startsWith("context-unknown:"));
		expect(alarms).toHaveLength(completed < 3 ? 0 : 1);
	}
});

test("a known native size does not become a missing completed sample when the next turn is running", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe"] });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true, config: { contextGuard: { unknownTurns: 1 } } });
	adapter.probe = {
		readable: true,
		contextSession: "session",
		contextTurn: 1,
		completedTurn: 1,
		partialContextHistory: true,
		context: { tokens: 40, at: AT, source: "native" },
		contextTokens: 40,
	};
	await r.engine.tick();
	adapter.probe = {
		readable: true,
		contextSession: "session",
		contextPending: true,
		contextTurn: 2,
		completedTurn: 1,
		partialContextHistory: true,
		context: { unknown: "running" },
		unknownTurns: [1],
	};
	await r.engine.tick();
	expect(r.events.filter((e) => e.event === "alarm" && String(e.key).startsWith("context-unknown:"))).toHaveLength(0);
});

test("hourly health only reuses completed context from the same session", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "stewardMeter"] });
	adapter.stewardMeter = () => ({ rows: [], quality: { threadRereads: 0 } });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true });
	const session = "replacement-session";
	const pending = { readable: true, context: { unknown: "running" }, contextSession: session, contextPending: true };
	const known = (tokens: number, contextSession = "original-session", contextPending = false, at = AT) => ({
		readable: true,
		contextSession,
		contextPending,
		context: { tokens, at, source: "fixture" },
		contextTokens: tokens,
	});
	setSystemTime(NOW);
	adapter.probe = known(40_000);
	await r.engine.tick();
	setSystemTime(NOW + 60 * MIN);
	adapter.probe = pending;
	await r.engine.tick();
	expect(readHealth(r.store)).toMatchObject({ verdict: "WATCH", unknown: [] });
	expect(readHealth(r.store)?.tokens).toBeUndefined();

	adapter.probe = known(51_000, session, true, new Date(NOW + 1).toISOString());
	await r.engine.tick();
	setSystemTime(NOW + 120 * MIN);
	adapter.probe = pending;
	await r.engine.tick();
	expect(readHealth(r.store)?.tokens).toBeUndefined();

	// Sample timestamps are not unique across sessions.
	adapter.probe = known(42_000, session);
	await r.engine.tick();
	setSystemTime(NOW + 180 * MIN);
	adapter.probe = pending;
	await r.engine.tick();
	expect(readHealth(r.store)).toMatchObject({ verdict: "OK", tokens: 42_000, usageAt: AT });
});

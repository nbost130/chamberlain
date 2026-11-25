import { afterEach, expect, setSystemTime, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
import { parseContextGuard } from "../config/context-guard.ts";
import { parseConfigDoc } from "../config/layout-schema.ts";
import { guardedHealth, readHealth } from "../steward/steward-health.ts";
import { healthTicker } from "../steward/steward-health-ticker.ts";
import { createEngine } from "./engine.ts";

const { rig } = useCoreEngineFixtures(createEngine);
const STEWARD = "steward-test";
const SESSION = "provider-session";
const NOW = Date.now();
const MIN = 60_000;
const AT = new Date(NOW).toISOString();

afterEach(() => setSystemTime());

function unknown(turn: number, unknownTurns: number[] = [turn]): StewardProbe {
	return {
		readable: true,
		context: { unknown: "newest turn has no valid context measurement" },
		contextSession: SESSION,
		contextTurn: turn,
		completedTurn: turn,
		unknownTurns,
	};
}

function known(tokens: number, extra: Partial<StewardProbe> = {}): StewardProbe {
	return {
		readable: true,
		contextSession: SESSION,
		context: { tokens, source: "fixture", at: AT, window: 256_000 },
		contextTokens: tokens,
		...extra,
	};
}

const alerts = (r: ReturnType<typeof rig>, prefix: string) =>
	r.events.filter((e) => e.event === "alarm" && String(e.key).startsWith(prefix));

test("completed unknown turns raise one alarm and queue one Steward hand-off across ticks and restart", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "handoffInstruction"] });
	adapter.probe = unknown(2, [2, 1]);
	const options = { adapter, steward: STEWARD, config: { contextGuard: { handoffTurns: 4 } }, housekeeping: true };
	const r = rig(options);
	await r.engine.tick();
	expect(readHealth(r.store)?.verdict).toBe("WATCH");
	expect(alerts(r, "context-unknown:")).toHaveLength(0);
	adapter.probe = { ...unknown(2, [2, 1]), contextTurn: 3 };
	await r.engine.tick();
	expect(alerts(r, "context-unknown:")).toHaveLength(0);
	adapter.probe = unknown(3, [3, 2, 1]);
	await r.engine.tick();
	expect(alerts(r, "context-unknown:")).toHaveLength(1);
	expect(r.store.wakes.find(`steward-handoff:${SESSION}`)).toBeUndefined();
	adapter.probe = unknown(4, [4, 3, 2, 1]);
	await r.engine.tick();
	await r.engine.tick();
	expect(readHealth(r.store)?.report).toContain("turn-count fallback");
	expect(alerts(r, "context-unknown:")).toHaveLength(1);
	expect(r.store.wakes.find(`steward-handoff:${SESSION}`)).toBeDefined();
	await r.engine.stop();
	const restarted = rig({ ...options, store: r.store });
	await restarted.engine.tick();
	expect(alerts(restarted, "context-unknown:")).toHaveLength(0);
	expect(r.store.wakes.find(`steward-handoff:${SESSION}`)).toBeDefined();
	expect(adapter.wakes.filter((wake) => wake.deliveryId === `steward-handoff:${SESSION}`)).toHaveLength(1);
});

test("a provider with no size history is counted turn by turn, and a turn in progress does not reset the count", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe"] });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true });
	for (const turn of [2, 3, 4]) {
		adapter.probe = { ...unknown(turn), previousCompletedTurn: turn - 1, partialContextHistory: true };
		await r.engine.tick();
		expect(alerts(r, "context-unknown:")).toHaveLength(turn === 4 ? 1 : 0);
		adapter.probe = { ...adapter.probe, contextTurn: turn + 1 };
		await r.engine.tick();
	}
	adapter.probe = known(1000, { completedTurn: 5, contextTurn: 5 });
	await r.engine.tick();
	adapter.probe = { ...unknown(6), previousCompletedTurn: 5, partialContextHistory: true };
	await r.engine.tick();
	expect(alerts(r, "context-unknown:")).toHaveLength(1);
});

test("a provider that cannot compact is handed off and is never sent a compaction", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "compact", "handoffInstruction"] });
	adapter.probe = known(150_000, { canCompact: false, compactions: 0 });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true });
	await r.engine.tick();
	expect(r.events.filter((e) => e.event === "fire" && e.kind === "compact")).toHaveLength(0);
	expect(r.store.wakes.find(`steward-handoff:${SESSION}`)).toBeDefined();
});

test("the Steward named in guardedThreads is guarded once, by its own check", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "compact"] });
	const requests: string[] = [];
	adapter.probe = known(150_000, { compactions: 0 });
	adapter.compactThread = async (id) => {
		requests.push(id);
		return { ok: true };
	};
	const config = { guardedThreads: [{ threadId: STEWARD, action: "compact" }] };
	const r = rig({ adapter, steward: STEWARD, config, housekeeping: true });
	await r.engine.tick();
	expect(requests).toEqual([]);
	expect(r.events.filter((e) => e.event === "fire" && e.kind === "compact")).toHaveLength(1);
});

test("a fallback found for one provider session never hands off another", async () => {
	const handed: string[] = [];
	const run = async (session: string) => {
		const r = rig({});
		const tick = healthTicker({
			store: r.store,
			collect: () => guardedHealth({ thread: STEWARD, probe: known(1000), policy: parseContextGuard(undefined) }),
			contextHandoff: () => ({ thread: STEWARD, session, reason: "fixture" }),
			handoff: (_h, s) => {
				handed.push(s);
			},
		});
		await tick();
		return readHealth(r.store)?.verdict;
	};
	expect(await run("an-earlier-session")).not.toBe("HAND OFF");
	expect(handed).toEqual([]);
	expect(await run(SESSION)).toBe("HAND OFF");
	expect(handed).toEqual([SESSION]);
});

test("a shared window-share limit drives both health and Steward compaction", async () => {
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "compact"] });
	adapter.probe = known(160_000);
	const r = rig({
		adapter,
		steward: STEWARD,
		config: { compactTokens: 350_000, contextGuard: { compactShare: 0.6 } },
		housekeeping: true,
	});
	await r.engine.tick();
	expect(readHealth(r.store)).toMatchObject({ verdict: "COMPACT", tokens: 160_000, limits: { compactAt: 153_600 } });
	expect(r.events.filter((e) => e.event === "fire" && e.kind === "compact")).toHaveLength(1);
});

test("a provider refusal after a compaction request hands off even when the latest turn has no size", async () => {
	setSystemTime(NOW);
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe", "compact", "handoffInstruction"] });
	adapter.probe = known(150_000, { compactions: 0, retryLostCompact: false });
	const r = rig({ adapter, steward: STEWARD, housekeeping: true });
	await r.engine.tick();
	expect(r.events.some((e) => e.event === "delivered" && String(e.deliveryId).startsWith("compact:"))).toBe(true);
	adapter.probe = { ...unknown(2), canCompact: false, retryLostCompact: false, compactions: 0 };
	await r.engine.tick();
	expect(readHealth(r.store)?.report).toContain("cannot compact");
	expect(r.store.wakes.find(`steward-handoff:${SESSION}`)).toBeDefined();
	setSystemTime(NOW + 31 * MIN);
	await r.engine.tick();
	expect(r.events.filter((e) => e.event === "fire" && e.kind === "compact")).toHaveLength(1);
});

test("additional guards are opt-in and compact only their own threads, then alarm if compaction did not finish", async () => {
	setSystemTime(NOW);
	const adapter = createFakeAdapter({ capabilities: ["stewardProbe"] });
	const requests: string[] = [];
	let probe = known(160_000, { compactions: 0, retryLostCompact: false });
	adapter.stewardProbe = () => probe;
	adapter.compactThread = async (id) => {
		requests.push(id);
		return { ok: true };
	};
	const unconfigured = rig({ adapter });
	await unconfigured.engine.tick();
	expect(requests).toEqual([]);
	const r = rig({
		adapter,
		config: {
			guardedThreads: [
				{ threadId: "warned", compactTokens: 350_000, compactShare: 0.6, action: "alarm" },
				{ threadId: "compacted", compactTokens: 150_000, action: "compact" },
			],
		},
	});
	await r.engine.tick();
	expect(requests).toEqual(["compacted"]);
	expect(alerts(r, "context-limit:").map((e) => e.key)).toEqual(["context-limit:warned"]);
	setSystemTime(NOW + 31 * MIN);
	probe = { ...unknown(2), compactions: 0, retryLostCompact: false };
	await r.engine.tick();
	await r.engine.tick();
	expect(requests).toEqual(["compacted"]);
	expect(alerts(r, "context-limit:").map((e) => e.key)).toEqual(["context-limit:warned", "context-limit:compacted"]);
});

test("the additive config accepts existing settings and rejects malformed policies", () => {
	const legacy = { schemaVersion: 1, compactTokens: 350_000 };
	expect(parseConfigDoc(legacy)).toBe(legacy);
	expect(() => parseConfigDoc({ ...legacy, contextGuard: { compactShare: 1.5 } })).toThrow("share");
	expect(() => parseConfigDoc({ ...legacy, contextGuard: { unknownTurns: 3, handoffTurns: 2 } })).toThrow("at least");
	expect(() => parseConfigDoc({ ...legacy, guardedThreads: [{ threadId: "pin", action: "unknown" }] })).toThrow(
		"action",
	);
	const pin = { threadId: "pin", action: "compact" };
	expect(() => parseConfigDoc({ ...legacy, guardedThreads: [pin, pin] })).toThrow("repeat");
});

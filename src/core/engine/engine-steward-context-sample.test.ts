import { afterEach, expect, setSystemTime, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { readHealth } from "../steward/steward-health.ts";
import { createEngine } from "./engine.ts";

const { rig } = useCoreEngineFixtures(createEngine);
const STEWARD = "steward-test";
const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const MIN = 60_000;
afterEach(() => setSystemTime());

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

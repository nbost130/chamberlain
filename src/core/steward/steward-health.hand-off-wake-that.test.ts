/** steward-health, continued: see steward-health.test.ts for the overview. */

import { expect, test } from "bun:test";
import { parseAsk } from "../../ask-parse.ts";
import {
	assistant,
	degraded,
	fakeId,
	fixture,
	handingOff,
	hook,
	measure,
	queued,
	row,
	session,
} from "../../testing/core-steward-health-fixtures.ts";
import { testRelay } from "../../testing/relay.ts";
import { memStore } from "../../testing/store.ts";
import { askQuestion, QUEUE } from "../items/questions.ts";
import { readHealth } from "./steward-health.ts";
import { HEALTH_CONFIG as C } from "./steward-health-config.ts";
import { healthTicker } from "./steward-health-ticker.ts";

test("a hand-off wake that fails delivery is retried by the relay, then dead-lettered with its alarm, and the check does not queue a second", async () => {
	const store = memStore();
	let now = Date.now(),
		posts = 0;
	const alarms: string[] = [];
	const tick = handingOff(
		store,
		degraded(
			() => session,
			() => now,
		),
		() => now,
	);
	await tick();
	const { drain } = testRelay(
		store,
		{
			ready: () => true,
			send: async () => {
				posts++;
				return { ok: false, status: 503 };
			},
		},
		{ alarm: (k) => alarms.push(k) },
	);
	await drain();
	expect(posts).toBe(3);
	expect(store.wakes.find(`steward-handoff:${session}`)).toMatchObject({ status: "dead_letter", attempts: 3 });
	expect(alarms).toContain("wake-dead-letter");
	now += C.intervalMs;
	await tick();
	// The dead-lettered row waits for the operator's retry or cancel (the alarm says so); the hourly check queues nothing new.
	expect(store.wakes.rows().filter((r) => r.status === "pending")).toHaveLength(0);
	expect(store.wakes.find(`steward-handoff:${session}`)).toMatchObject({ status: "dead_letter", attempts: 3 });
	await drain();
	expect(posts).toBe(3);
});

test("a hand-off wake that fails once is delivered by a retry", async () => {
	const store = memStore();
	let posts = 0;
	await handingOff(
		store,
		degraded(
			() => session,
			() => Date.now(),
		),
		() => Date.now(),
	)();
	const { drain } = testRelay(store, {
		ready: () => true,
		send: async () => ({ ok: ++posts > 1, status: posts > 1 ? 202 : 503 }),
	});
	await drain();
	expect(posts).toBe(2);
	expect(store.wakes.find(`steward-handoff:${session}`)).toMatchObject({ status: "delivered", attempts: 2 });
});

test("an adapter with no way to say how a Steward hands off gets the question instead, once per session across restart, compaction and Not yet", async () => {
	const store = memStore();
	let now = Date.now(),
		calls = 0,
		active = session;
	const collect = degraded(
		() => active,
		() => now,
	);
	const ask = async (raw: object) => {
		calls++;
		askQuestion(store, parseAsk(raw, `Q-health${calls}`));
	};
	const tick = healthTicker({ store, collect, ask, now: () => now });
	await tick();
	await tick();
	expect(calls).toBe(1);
	expect(readHealth(store)?.verdict).toBe("HAND OFF");
	expect(queued(store)).toHaveLength(0);
	store.items.resolve(QUEUE, "Q-health1");
	now += C.intervalMs;
	await healthTicker({ store, collect, ask, now: () => now })();
	expect(calls).toBe(1);
	active = fakeId("b");
	now += C.intervalMs;
	await tick();
	expect(calls).toBe(2);
});

test("a COMPACT verdict is persisted but starts no hand-off and raises no question", async () => {
	const store = memStore();
	let calls = 0;
	await healthTicker({
		store,
		collect: () =>
			measure(
				[
					...fixture,
					row({ type: "system", subtype: "compact_boundary", timestamp: "new" }),
					hook(1, false),
					assistant(C.compactContext + 1),
				],
				session,
			),
		ask: async () => {
			calls++;
		},
		handoff: () => {
			calls++;
		},
	})();
	expect(readHealth(store)?.verdict).toBe("COMPACT");
	expect(calls).toBe(0);
});

test("failed ask retries; collection failure persists WATCH", async () => {
	const store = memStore();
	let calls = 0,
		now = Date.now();
	const tick = healthTicker({
		store,
		now: () => now,
		collect: () => measure([...fixture, hook(1), hook(2), assistant(10_000)], session, now),
		ask: async () => {
			calls++;
			throw Error("offline");
		},
	});
	await expect(tick()).rejects.toThrow("offline");
	expect(readHealth(store)?.verdict).toBe("HAND OFF");
	now += C.intervalMs;
	await expect(tick()).rejects.toThrow();
	expect(calls).toBe(2);
	now += C.intervalMs;
	await healthTicker({
		store,
		now: () => now,
		collect: async () => {
			throw Error("unavailable");
		},
		ask: async () => {},
	})();
	expect(readHealth(store)?.verdict).toBe("WATCH");
});

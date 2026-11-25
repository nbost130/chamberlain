import { expect, test } from "bun:test";
import { testRelay } from "../../testing/relay.ts";
import { memStore } from "../../testing/store.ts";
import { type PrepareReason, preparationFailed } from "./preflight.ts";

test("a failing preflight spends no attempt and logs each reason change on the same row", async () => {
	const store = memStore();
	const reasons: unknown[] = [];
	let t = 1_000;
	let reason: PrepareReason = "busy";
	const wake = { ready: () => true, prepare: async () => preparationFailed(reason), send: async () => ({ ok: true }) };
	const { relay } = testRelay(store, wake, {
		now: () => t,
		log: (event, data) => {
			if (event === "deliver-preflight-failed") reasons.push([data?.deliveryId, data?.reason]);
		},
	});
	store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: t });
	for (const result of ["busy", "busy", "auth", "auth", "busy"] as const) {
		reason = result;
		await relay.pass();
		t += 60_000;
	}
	expect(store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
	expect(reasons).toEqual([
		["w1", "busy"],
		["w1", "auth"],
		["w1", "busy"],
	]);
	store.close();
});

test("receivers have independent alarm lifetimes, with one alarm across reason changes until success", async () => {
	const store = memStore();
	const alerts: string[] = [];
	let steward: PrepareReason | undefined = "auth";
	const transport = (reason: () => PrepareReason | undefined) => ({
		ready: () => true,
		prepare: async () => {
			const r = reason();
			return r ? preparationFailed(r) : { ok: true as const };
		},
		send: async () => ({ ok: true }),
	});
	const { relay } = testRelay(
		store,
		transport(() => steward),
		{
			receivers: { desk: { wake: transport(() => "quota"), gate: () => "idle" } },
			alarm: (dedupKey) => {
				alerts.push(dedupKey);
				store.items.observe({ source: "alarm", kind: "alarm", dedupKey });
			},
		},
	);
	store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: 1 });
	store.wakes.enqueue({ deliveryId: "d1", message: "m", queuedAt: 2, receiver: "desk" });
	await relay.pass();
	expect(alerts).toEqual(["wake-preflight", "desk:model-quota"]);
	steward = "config";
	await relay.pass();
	expect(alerts).toHaveLength(2);
	steward = undefined;
	await relay.pass();
	expect(store.items.get("alarm", "wake-preflight")?.status).toBe("resolved");
	expect(store.items.get("alarm", "desk:model-quota")?.status).toBe("triggered");
	steward = "quota";
	store.wakes.enqueue({ deliveryId: "w2", message: "m", queuedAt: 3 });
	await relay.pass();
	expect(alerts).toEqual(["wake-preflight", "desk:model-quota", "model-quota"]);
	store.close();
});

test("an outage that alternates between busy and unreachable still alarms once it has lasted", async () => {
	const store = memStore();
	const alerts: string[] = [];
	let t = 1_000;
	let reason: PrepareReason = "busy";
	const wake = { ready: () => true, prepare: async () => preparationFailed(reason), send: async () => ({ ok: true }) };
	const { relay } = testRelay(store, wake, {
		now: () => t,
		alarm: (dedupKey) => {
			alerts.push(dedupKey);
			store.items.observe({ source: "alarm", kind: "alarm", dedupKey });
		},
	});
	store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: t });
	for (let minute = 0; minute < 16; minute++) {
		reason = minute % 2 ? "unreachable" : "busy";
		await relay.pass();
		if (minute < 15) expect(alerts).toEqual([]);
		t += 60_000;
	}
	expect(alerts).toEqual(["wake-preflight"]);
	store.close();
});

test("the relay discards an adapter's raw result detail or thrown cause and honors a retry delay", async () => {
	const store = memStore();
	const secret = "synthetic-private-reply";
	let now = 1;
	let calls = 0;
	const sink: unknown[] = [];
	const { relay } = testRelay(
		store,
		{
			ready: () => true,
			prepare: async () => {
				if (++calls === 1) return { ok: false, reason: "auth", detail: secret, retryAfterMs: 30 };
				throw new Error(secret, { cause: new Error(secret) });
			},
			send: async () => ({ ok: true }),
		},
		{
			now: () => now,
			log: (event, data) => sink.push([event, data]),
			alarm: (...args) => sink.push(args),
		},
	);
	store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: now });
	await relay.pass();
	now = 30;
	await relay.pass();
	expect(calls).toBe(1);
	now = 31;
	await relay.pass();
	expect(calls).toBe(2);
	expect(JSON.stringify(sink)).toContain("unknown");
	expect(JSON.stringify(sink)).not.toContain(secret);
	store.close();
});

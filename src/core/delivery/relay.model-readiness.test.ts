import { expect, test } from "bun:test";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import { createOutbox } from "./deliver.ts";
import { createRelay } from "./relay.ts";

function world() {
	const store = memStore();
	const lock = testRelayLock(store);
	const state = { ready: false, t: 1_000_000, sent: 0, freshness: "send" as "send" | "wait" | "cancel" };
	const wake = {
		ready: () => true,
		prepare: async () => state.ready,
		send: async () => {
			state.sent++;
			return { ok: true };
		},
	};
	const relay = createRelay({
		store,
		lock,
		wake,
		gate: () => "idle",
		log: () => {},
		alarm: () => {},
		now: () => state.t,
		retryAfterMs: () => 1,
		validateWake: async () => state.freshness,
	});
	createOutbox({ store, log: () => {} }).deliver("pending work", "one", { kind: "failed", thread: "source" });
	return { store, lock, state, wake, relay };
}

test("provider outage retains pending work without exhausting attempts; recovery delivers exactly once", async () => {
	const r = world();
	for (let n = 0; n < 5; n++) {
		await r.relay.pass();
		r.state.t += 1000;
	}
	expect(r.store.wakes.find("one")).toMatchObject({ status: "pending", attempts: 0 });
	expect(r.state.sent).toBe(0);
	r.state.ready = true;
	await r.relay.pass();
	await r.relay.pass();
	expect(r.store.wakes.find("one")).toMatchObject({ status: "delivered", attempts: 1 });
	expect(r.state.sent).toBe(1);
});

test("a failure already queued is cancelled after recovery, without waking or consuming an attempt", async () => {
	const r = world();
	r.state.ready = true;
	r.state.freshness = "wait";
	await r.relay.pass();
	expect(r.store.wakes.find("one")?.attempts).toBe(0);
	r.state.freshness = "cancel";
	await r.relay.pass();
	expect(r.store.wakes.find("one")?.status).toBe("cancelled");
	expect(r.state.sent).toBe(0);
});

test("losing the relay lock during model preparation sends nothing", async () => {
	const r = world();
	r.wake.prepare = async () => {
		r.lock.release();
		return true;
	};
	await r.relay.pass();
	expect(r.store.wakes.find("one")?.attempts).toBe(0);
	expect(r.state.sent).toBe(0);
});

/** A transport preflight that keeps failing holds the row, and says so once per row. */
import { expect, test } from "bun:test";
import { testRelay } from "../../testing/relay.ts";
import { memStore } from "../../testing/store.ts";

test("a failing preflight retains the row with no attempt used, and logs deliver-preflight-failed once for it", async () => {
	const store = memStore();
	const events: { event: string; deliveryId?: unknown }[] = [];
	let t = 1_000;
	const wake = { ready: () => true, prepare: async () => false, send: async () => ({ ok: true }) };
	const { relay } = testRelay(store, wake, {
		now: () => t,
		retryAfterMs: () => 0,
		log: (event, data) => events.push({ event, deliveryId: data?.deliveryId }),
	});
	store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: t });
	for (let i = 0; i < 4; i++) {
		await relay.pass();
		t += 60_000;
	}
	expect(store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
	expect(events.filter((e) => e.event === "deliver-preflight-failed")).toEqual([
		{ event: "deliver-preflight-failed", deliveryId: "w1" },
	]);
});

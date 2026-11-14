/** The wake path's events through the real relay, the real outbox and a real `obs.db`: the digest lists its members and kept ones as corrs, and its delivery joins them. */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../../testing/lock.ts";
import { eventRows, THREAD } from "../../testing/obs.ts";
import { memStore } from "../../testing/store.ts";
import { createOutbox } from "../deliver.ts";
import { logFor, obsFor } from "../log.ts";
import { createRelay } from "../relay.ts";
import { corrOf } from "./fields.ts";

function world() {
	const store = memStore();
	const log = logFor(store);
	const clock = { t: 1_000_000 };
	const posts: string[] = [];
	const outbox = createOutbox({ store, log, now: () => clock.t });
	const relay = createRelay({
		store,
		lock: testRelayLock(store),
		gate: () => "idle",
		log,
		alarm: () => {},
		now: () => clock.t,
		maxAttempts: 3,
		retryAfterMs: () => 1000,
		wake: {
			ready: () => true,
			send: async (id) => {
				posts.push(id);
				return { ok: true, status: 202 };
			},
		},
	});
	return { store, outbox, relay, posts, obs: obsFor(store) };
}

describe("wake.composed and the events around it", () => {
	test("a digest lists its members and the ones it kept as corrs (never raw delivery ids), and its delivery carries the same corr", async () => {
		const w = world();
		w.outbox.deliver("text of a1", "thread-a:wait:1", { kind: "turn_ended", thread: THREAD });
		w.outbox.deliver("text of a2", "thread-a:wait:2", { kind: "turn_ended", thread: THREAD });
		w.outbox.deliver("text of b", "thread-b:wait:1", {
			kind: "turn_ended",
			thread: "9f8e7d6c-5b4a-4321-8fed-cba987654321",
		});
		await w.relay.pass();
		const [composed] = eventRows(w.obs, "event = 'wake.composed'");
		const data = JSON.parse(composed?.data ?? "{}") as { members: string[]; kept: string[]; folded: number };
		expect(data.members).toEqual(["thread-a:wait:1", "thread-a:wait:2", "thread-b:wait:1"].map(corrOf));
		expect(data.kept).toHaveLength(2);
		expect(data.kept.every((k) => data.members.includes(k))).toBe(true);
		expect(data.folded).toBe(1);
		const digest = w.store.wakes.rows("all")[0];
		expect(digest?.deliveryId).toBeTruthy();
		expect(composed?.corr).toBe(corrOf(digest?.deliveryId ?? ""));
		expect(composed?.delivery).toBe(corrOf(digest?.deliveryId ?? ""));
		const [delivered] = eventRows(w.obs, "event = 'wake.delivered'");
		expect(delivered).toMatchObject({ corr: composed?.corr, delivery: composed?.delivery });
		expect(JSON.stringify(eventRows(w.obs))).not.toContain("thread-a");
		expect(w.obs.counters).toEqual({ rejected: 0, redacted: 0, failed: 0, dropped: 0 });
	});

	test("the held candidate carries the corr of its own delivery id, which the digest then lists", async () => {
		const w = world();
		w.outbox.deliver("text", "thread-c:wait:1", { kind: "turn_ended", thread: THREAD });
		const [held] = eventRows(w.obs, "event = 'wake.held' OR event = 'wake.queued'");
		expect(held?.corr).toBe(corrOf("thread-c:wait:1"));
		await w.relay.pass();
		const composed = JSON.parse(eventRows(w.obs, "event = 'wake.composed'")[0]?.data ?? "{}") as { members: string[] };
		expect(composed.members).toContain(held?.corr as string);
	});
});

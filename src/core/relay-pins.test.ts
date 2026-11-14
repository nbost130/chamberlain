/**
 * Paths of the relay that relay.test.ts reaches only in passing, pinned through the relay's public surface (`pass`, `audit`) before its
 * internals were split into smaller functions: a failing read of the rights state, a prerequisite that cannot be queued, a lock lost between the
 * prerequisite and its row, a compose that finds nothing, and a gate that cannot be read.
 */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { createOutbox, type WakeResult } from "./deliver.ts";
import type { Gate } from "./hold.ts";
import { createRelay, type RelayDeps } from "./relay.ts";
import { RIGHTS_SENT_KEY, rightsFirstId, rightsStateKey } from "./rights-sent.ts";
import type { Store } from "./store.ts";

const H1 = "a".repeat(64);
const STATE = { steward: "steward-1", session: "s1", hash: H1 };
const POINTER = { steward: "steward-1", hash: H1, at: "t0" };
const rightsNow: NonNullable<RelayDeps["rightsNow"]> = async () => ({
	...STATE,
	wake: (forId: string) => ({
		message: `[chamberlain] rights for ${forId}`,
		stamp: { ...STATE, at: "now", used: 10, full: true as const },
	}),
});

function world(
	o: {
		over?: (s: Store) => Store;
		rightsNow?: RelayDeps["rightsNow"];
		gate?: () => Gate;
		wake?: (id: string, lock: ReturnType<typeof testRelayLock>) => Promise<WakeResult>;
	} = {},
) {
	const base = memStore();
	const store = o.over ? o.over(base) : base;
	const lock = testRelayLock(store);
	const posts: string[] = [];
	const events: { event: string; data?: Record<string, unknown> }[] = [];
	const clock = { t: 1_000_000 };
	const relay = createRelay({
		store,
		lock,
		gate: o.gate ?? (() => "idle"),
		log: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
		alarm: () => {},
		now: () => clock.t,
		maxAttempts: 3,
		retryAfterMs: () => 1000,
		...(o.rightsNow !== undefined || !("rightsNow" in o) ? { rightsNow: o.rightsNow ?? rightsNow } : {}),
		wake: {
			ready: () => true,
			send: async (id) => {
				posts.push(id);
				return o.wake ? o.wake(id, lock) : { ok: true, status: 202 };
			},
		},
	});
	const outbox = createOutbox({ store: base, log: () => {}, now: () => clock.t });
	const event = (name: string) => events.find((e) => e.event === name);
	return { base, store, relay, outbox, posts, events, event, clock, lock };
}

describe("a Steward row that waits on the rights: what stops it, and what is left behind", () => {
	test("a rights state that cannot be read from the database sends nothing, uses no attempt, and logs it", async () => {
		const w = world({
			over: (s) => ({
				...s,
				state: {
					...s.state,
					get: () => {
						throw Error("db locked");
					},
				},
			}),
		});
		w.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [POINTER] });
		expect(await w.relay.pass()).toEqual([]);
		expect(w.posts).toEqual([]);
		expect(w.base.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		expect(w.event("rights-first-error")?.data).toMatchObject({ deliveryId: "w1" });
		expect(String(w.event("rights-first-error")?.data?.error)).toContain("db locked");
	});

	test("fifty prerequisites for one state that all ended without the record showing it: the row is refused and the log says so", async () => {
		const w = world();
		const key = rightsStateKey(STATE);
		for (let n = 1; n <= 50; n++) {
			const id = rightsFirstId("w1", key, n);
			w.outbox.deliver("old prerequisite", id, { kind: "rights" });
			const row = w.base.wakes.find(id);
			if (!row) throw Error("seeded row missing");
			w.base.wakes.finish(row.id, "delivered", w.clock.t);
		}
		w.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [POINTER] });
		expect(await w.relay.pass()).toEqual([]);
		expect(w.posts).toEqual([]);
		expect(String(w.event("rights-first-error")?.data?.error)).toContain("50 prerequisites for one state");
		expect(w.base.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
	});

	test("a row cancelled while its rights were being read gets no prerequisite: skipped, and logged with the reason", async () => {
		const w = world({
			rightsNow: async () => {
				const row = w.base.wakes.find("w1");
				if (row) w.base.wakes.cancel("w1", w.clock.t);
				return rightsNow();
			},
		});
		w.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [POINTER] });
		await w.relay.pass();
		expect(w.posts).toEqual([]);
		const skipped = w.event("rights-first-skipped");
		expect(skipped?.data).toMatchObject({ deliveryId: "w1", first: rightsFirstId("w1", rightsStateKey(STATE)) });
		expect(w.base.wakes.rows("all").map((r) => r.deliveryId)).toEqual(["w1"]);
	});

	test("a prerequisite the outbox refuses to queue is an error for that row: nothing is sent and no attempt is used", async () => {
		const w = world({
			over: (s) => ({
				...s,
				wakes: { ...s.wakes, enqueue: (x) => (x.kind === "rights" ? false : s.wakes.enqueue(x)) },
			}),
		});
		w.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [POINTER] });
		await w.relay.pass();
		expect(w.posts).toEqual([]);
		expect(String(w.event("rights-first-error")?.data?.error)).toContain("is already known");
		expect(w.base.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
	});

	test("the lock lost right after the prerequisite went: the prerequisite is delivered, the row is not sent, and the pass reports nothing", async () => {
		const F = rightsFirstId("w1", rightsStateKey(STATE));
		const w = world({
			wake: async (id, lock) => {
				if (id === F) lock.release();
				return { ok: true, status: 202 };
			},
		});
		w.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [POINTER] });
		expect(await w.relay.pass()).toEqual([]);
		expect(w.posts).toEqual([F]);
		expect(w.base.wakes.find(F)).toMatchObject({ status: "delivered", kind: "rights" });
		expect(w.base.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		expect(w.base.state.get(RIGHTS_SENT_KEY)).toMatchObject({ hash: H1 });
	});

	test("a prerequisite sent on its own whose state cannot be read is not sent, and no attempt is used", async () => {
		const w = world({
			rightsNow: async () => {
				throw Error("transcript unreadable");
			},
		});
		const F = rightsFirstId("w1", rightsStateKey(STATE));
		w.outbox.deliver("rights", F, { kind: "rights" });
		await w.relay.pass();
		expect(w.posts).toEqual([]);
		expect(w.base.wakes.find(F)).toMatchObject({ status: "pending", attempts: 0 });
		expect(w.event("rights-first-error")?.data).toMatchObject({ deliveryId: F });
	});

	test("a prerequisite sent on its own for an older state is cancelled, not sent", async () => {
		const w = world();
		const old = rightsFirstId("w1", rightsStateKey({ ...STATE, session: "older" }));
		w.outbox.deliver("rights", old, { kind: "rights" });
		await w.relay.pass();
		expect(w.posts).toEqual([]);
		expect(w.base.wakes.find(old)?.status).toBe("cancelled");
		expect(w.event("rights-first-obsolete")?.data).toMatchObject({ deliveryId: old });
	});
});

describe("the relay's other quiet paths", () => {
	test("held wakes whose compose finds nothing leave them held and say nothing", async () => {
		const w = world({ over: (s) => ({ ...s, wakes: { ...s.wakes, compose: () => undefined } }) });
		w.outbox.deliver("a", "h1", { kind: "turn_ended", thread: "t1" });
		await w.relay.pass();
		expect(w.posts).toEqual([]);
		expect(w.event("composed")).toBeUndefined();
		expect(w.base.wakes.held()).toHaveLength(1);
	});

	test("an audit with a gate that throws logs it and still checks the rest", () => {
		const w = world({
			gate: () => {
				throw Error("gate unreadable");
			},
		});
		w.relay.audit();
		expect(w.event("gate-error")?.data).toEqual({ error: "Error: gate unreadable" });
	});
});

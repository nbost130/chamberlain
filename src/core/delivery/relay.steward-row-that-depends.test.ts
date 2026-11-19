/** relay, continued: see relay.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { invalidateRights, RIGHTS_SENT_KEY, rightsFirstId, rightsStateKey } from "../steward/rights-sent.ts";
import { openStore } from "../store/sqlite-store.ts";
import type { Store } from "../store/store.ts";
import { createRelay } from "./relay.ts";

const { scratch, rig, H1, stamp, world, pointer, fullAt, compactWorld } = useCoreRelayFixtures(createRelay);

describe("a Steward row that depends on the rights goes only when the durable record shows the Steward there now holds them", () => {
	test("the record is written in the transaction that marks the row delivered: when that commit fails, neither exists", async () => {
		const r = world();
		r.outbox.deliver("block", "w1", { kind: "needs_input", rights: [{ ...stamp, session: "s1", full: true }] });
		const refusing: Store = {
			...r.store,
			state: {
				...r.store.state,
				set: () => {
					throw Error("SQLITE_FULL: database or disk is full");
				},
			},
		};
		const relay = createRelay({
			store: refusing,
			lock: testRelayLock(refusing),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			maxAttempts: 3,
			wake: { ready: () => true, send: async () => ({ ok: true, status: 202 }) },
		});
		await relay.pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		expect(r.record()).toBeUndefined();
	});

	test("a full-block wake writes the record when it is delivered; a compaction that clears it later makes a failed row's retry queue `:2`", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		const F = rightsFirstId("w1", r.key());
		r.store.state.delete(RIGHTS_SENT_KEY);
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await r.relay().pass()).toEqual([rightsFirstId("w1", r.key(), 2), "w1"]);
		expect(r.ids()).toEqual([F, "w1", rightsFirstId("w1", r.key(), 2), "w1"]);
	});

	test("a prerequisite for a state that has passed is cancelled, never sent on its own after newer rights", async () => {
		const r = world();
		r.store.state.set(RIGHTS_SENT_KEY, { steward: "steward-1", session: "s1", hash: H1 });
		const old = rightsFirstId("gone", rightsStateKey({ steward: "steward-1", session: "s0", hash: H1 }));
		r.store.wakes.enqueue({
			deliveryId: old,
			message: "old rights",
			queuedAt: r.clock.t,
			kind: "rights",
			rights: [{ steward: "steward-1", session: "s0", hash: H1, full: true }],
		});
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find(old)?.status).toBe("cancelled");
		expect(r.record()).toMatchObject({ session: "s1" });
	});

	test("rights that cannot be read: the prerequisite carries the notice, writes no record, and once it is delivered the row goes", async () => {
		const r = world();
		delete r.st.hash;
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const F = rightsFirstId("w1", r.key());
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		expect(r.ids()).toEqual([F, "w1"]);
		expect(r.posts[0]!.message).toContain("unreadable");
		expect(r.record()).toBeUndefined();
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await r.relay().pass()).toEqual(["w1"]);
	});

	test("a check that throws does not hold a principal-facing row: it goes with a notice and an alarm, and the next row reads the rights again", async () => {
		let broken = true;
		const r = rig({
			rightsNow: async () => {
				if (broken) throw Error("transcript unreadable");
				return {
					steward: "steward-1",
					session: "s1",
					hash: H1,
					wake: (id: string) => ({ message: `[chamberlain] rights for ${id}`, stamp: fullAt(0) }),
				};
			},
		});
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1"]);
		expect(r.posts[0]!.message).toContain("could not be read for this wake");
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		expect(r.alarms).toContain("rights-unreadable");
		expect(r.store.state.get(RIGHTS_SENT_KEY)).toBeUndefined();
		broken = false;
		r.outbox.deliver("pointer 2", "w2", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.ids()).toHaveLength(3);
		expect(r.ids()[1]).toContain("w2:rights-first:");
		expect(r.ids()[2]).toBe("w2");
	});

	test("the stamps are frozen with the row, like its text", () => {
		const path = `${scratch()}/stamps.db`;
		const r = rig({ store: openStore(path) });
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const raw = new Database(path);
		expect(() => raw.exec("UPDATE outbox SET rights_for = NULL")).toThrow("immutable");
		raw.close();
		expect(r.store.wakes.find("w1")?.rights).toEqual([stamp]);
	});
});

describe("a compaction bumps the rights epoch inside its serial job: a full block composed before it never restores the record", () => {
	test("interleaving: a full wake in flight, the compaction asked for, the full wake lands, the next wake: it gets a prerequisite", async () => {
		const r = compactWorld();
		const f = r.fullInFlight();
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		const relay = r.relay();
		const passing = relay.pass();
		await r.until(f.started);
		// The engine asks for the compaction while F's POST is open: the relay queues it behind F.
		const compacting = relay.compact("compact:steward-1:1");
		f.release();
		await compacting;
		await passing;
		// F landed (epoch 0, the record written), THEN the compaction's job bumped the epoch and dropped the record, THEN P had to wait for the rights.
		expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		expect(r.store.wakes.find("F")?.status).toBe("delivered");
		expect(r.record()).toMatchObject({ hash: H1, epoch: 1 });
		expect(r.events.find((e) => e.event === "rights-invalidated")?.data).toMatchObject({
			reason: "compaction",
			epoch: 1,
		});
	});

	test("a full block whose delivered commit lands only after the bump (owed across the compaction) is marked delivered and writes nothing", async () => {
		const r = compactWorld();
		r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
		// F is accepted but its delivered commit fails: the relay owes it. The compaction goes, then the commit lands on the next pass.
		const relay = createRelay({
			store: r.broken,
			lock: testRelayLock(r.broken),
			gate: () => "idle",
			log: (event, data) => r.events.push({ event, ...(data ? { data } : {}) }),
			alarm: () => {},
			maxAttempts: 3,
			wake: {
				ready: () => true,
				send: async (id) => {
					r.posts.push({ id, message: "" });
					return { ok: true, status: 202 };
				},
			},
			compact: {
				ready: () => true,
				send: async (id) => {
					r.posts.push({ id, message: "" });
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		await relay.compact("compact:steward-1:1");
		expect(r.store.wakes.find("F")?.status).toBe("pending");
		r.broken.wakes.finish = r.store.wakes.finish;
		await relay.pass();
		expect(r.store.wakes.find("F")?.status).toBe("delivered");
		expect(r.record()).toEqual({ epoch: 1 });
		expect(r.events.find((e) => e.event === "rights-full-stale")?.data).toMatchObject({
			deliveryId: "F",
			epoch: 0,
			current: 1,
		});
		expect(r.ids()).toEqual(["F", "compact:steward-1:1"]);
	});

	test("a context shrink seen while a full block is in flight bumps the epoch: the block lands and writes nothing, and the next wake gets a prerequisite", async () => {
		const r = compactWorld();
		const f = r.fullInFlight();
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		const relay = r.relay();
		const passing = relay.pass();
		await r.until(f.started);
		// The engine's minute check, outside the serial queue.
		expect(invalidateRights(r.store)).toBe(1);
		f.release();
		await passing;
		expect(r.ids()).toEqual(["F", r.prereq("P", 1), "P"]);
		expect(r.events.some((e) => e.event === "rights-full-stale")).toBe(true);
	});

	test("the plain case: a full block delivered, then the compaction, then the next wake: the full rights go first", async () => {
		const r = compactWorld();
		r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
		const relay = r.relay();
		await relay.pass();
		expect(r.record()).toMatchObject({ hash: H1, epoch: 0 });
		await relay.compact("compact:steward-1:1");
		expect(r.record()).toEqual({ epoch: 1 });
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		await relay.pass();
		expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		// The rights the prerequisite brought are recorded under the new epoch: the wake after needs nothing ahead of it.
		r.outbox.deliver("pointer 2", "Q", { kind: "needs_input", rights: [{ ...pointer, epoch: 1 }] });
		await relay.pass();
		expect(r.ids().at(-1)).toBe("Q");
		expect(r.ids()).toHaveLength(5);
	});
});

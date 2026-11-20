/**
 * Held news rides in an immediate wake (audit round 1, finding 6). A message or a needs_input row went at once and left the held news behind
 * (posts=["m"], held=["n"]), so it went as a second Steward turn a few minutes later.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const { rig } = useCoreRelayFixtures(createRelay);
const MS = 180_000;

describe("an immediate wake carries or flushes the held news in the same wake", () => {
	test("must carry: a needs_input goes at once WITH the held note, in one POST; nothing is left held and nothing goes later", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		await relay.pass();
		expect(r.posts).toEqual([]);
		r.outbox.deliver("a thread needs your answer", "t2:input:q1", { kind: "needs_input", thread: "t2" });
		await relay.pass();
		expect(r.ids()).toEqual(["t2:input:q1"]);
		const sent = r.posts[0]!.message;
		expect(sent.startsWith("a thread needs your answer\n\n")).toBe(true);
		expect(sent).toContain("note from t1");
		expect(sent.endsWith(DELIVERY_ID_LINE("t2:input:q1"))).toBe(true);
		expect(r.store.wakes.held(null)).toEqual([]);
		expect(r.store.wakes.find("note:a")).toMatchObject({ status: "delivered" });
		expect(r.store.wakes.find("t2:input:q1")).toMatchObject({
			message: "a thread needs your answer",
			status: "delivered",
		});
		r.clock.t += MS * 2;
		await relay.pass();
		expect(r.posts).toHaveLength(1);
		expect(r.events.some((e) => e.event === "news-carried")).toBe(true);
	});

	test("must carry: a failure takes the held turn ends, notes and sweep with it", async () => {
		const r = rig({ debounceMs: MS });
		r.outbox.deliver("turn end of t1", "t1:ended:r1:1", { kind: "turn_ended", thread: "t1" });
		r.outbox.deliver("sweep findings", "sweep:1", { kind: "sweep" });
		r.outbox.deliver("note from t4", "note:z", { kind: "note", thread: "t4" });
		r.outbox.deliver("a failed run", "t3:failed:r9", { kind: "failed", thread: "t3" });
		await r.relay().pass();
		expect(r.ids()).toEqual(["t3:failed:r9"]);
		for (const text of ["a failed run", "turn end of t1", "sweep findings", "note from t4"])
			expect(r.posts[0]!.message).toContain(text);
		expect(r.store.wakes.held(null)).toEqual([]);
	});

	test("must not carry: a held transfer stays held (a switch's replays have their own batch)", async () => {
		const r = rig({ debounceMs: MS });
		r.w.gate = "busy";
		const relay = r.relay();
		r.store.wakes.hold({
			deliveryId: "transfer:1:g2",
			message: "a replayed wake",
			queuedAt: r.clock.t,
			kind: "transfer",
		});
		r.outbox.deliver("a thread needs your answer", "t2:input:q1", { kind: "needs_input", thread: "t2" });
		await relay.pass();
		expect(r.posts[0]!.message).not.toContain("a replayed wake");
		expect(r.store.wakes.held(null).map((h) => h.deliveryId)).toEqual(["transfer:1:g2"]);
	});

	test("must not carry: a row that is already a digest, and the desk's rows, take nothing", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("note a", "note:a", { kind: "note", thread: "t1" });
		r.clock.t += MS;
		await relay.pass();
		expect(r.ids()).toHaveLength(1);
		r.outbox.deliver("note b", "note:b", { kind: "note", thread: "t2" });
		r.outbox.deliver("turn end", "t9:ended:r1:1", { kind: "turn_ended", thread: "t9" });
		r.clock.t += MS;
		await relay.pass();
		expect(r.posts).toHaveLength(2);
		expect(r.posts[1]!.id.startsWith("digest:")).toBe(true);
	});

	test("must not carry past the size bound: news that would push the POST over it stays held and goes in its own wake", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("n".repeat(9_000), "note:big", { kind: "note", thread: "t1" });
		r.outbox.deliver("m".repeat(11_000), "t2:input:q1", { kind: "needs_input", thread: "t2" });
		await relay.pass();
		expect(r.posts[0]!.id).toBe("t2:input:q1");
		for (const p of r.posts) expect(exceedsEncodedCap(p.message, p.id)).toBe(false);
		expect(r.posts[0]!.message).not.toContain("nnnnnnnn");
		expect(r.store.wakes.held(null).map((h) => h.deliveryId)).toEqual(["note:big"]);
	});

	test("a refused POST consumes nothing: the news is still held and rides again on the retry", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		await relay.pass();
		r.outbox.deliver("a thread needs your answer", "t2:input:q1", { kind: "needs_input", thread: "t2" });
		r.w.answer = async () => ({ ok: false, status: 503 });
		await relay.pass();
		expect(r.store.wakes.held(null).map((h) => h.deliveryId)).toEqual(["note:a"]);
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		await relay.pass();
		expect(r.posts.at(-1)!.message).toContain("note from t1");
		expect(r.store.wakes.held(null)).toEqual([]);
	});

	test("the wake and its news are ONE commit (audit round 3): if the news cannot be bound, the wake is not recorded delivered either, and nothing goes twice", async () => {
		const base = memStore();
		const fail = { on: false };
		const store = {
			...base,
			wakes: {
				...base.wakes,
				compose: (...a: Parameters<typeof base.wakes.compose>) => {
					if (fail.on) throw new Error("SQLITE_FULL: database or disk is full");
					return base.wakes.compose(...a);
				},
			},
		};
		const r = rig({ store, debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		await relay.pass();
		r.outbox.deliver("a thread needs your answer", "t2:input:q1", { kind: "needs_input", thread: "t2" });
		fail.on = true;
		await relay.pass();
		// POSTed once, with the news; neither the wake nor the news is recorded: one commit, both or neither.
		expect(r.posts).toHaveLength(1);
		expect(base.wakes.find("t2:input:q1")).toMatchObject({ status: "pending" });
		expect(base.wakes.held(null).map((h) => h.deliveryId)).toEqual(["note:a"]);
		expect(r.events.some((e) => e.event === "delivered-record-failed")).toBe(true);
		fail.on = false;
		await relay.pass();
		// The commit retries without a second POST, and now both are recorded.
		expect(r.posts).toHaveLength(1);
		expect(base.wakes.find("t2:input:q1")).toMatchObject({ status: "delivered" });
		expect(base.wakes.held(null)).toEqual([]);
		expect(base.wakes.find("note:a")).toMatchObject({ status: "delivered" });
		r.clock.t += MS * 2;
		await relay.pass();
		expect(r.posts).toHaveLength(1);
	});

	test("must skip: with nothing held an immediate wake goes exactly as queued", async () => {
		const r = rig({ debounceMs: MS });
		r.outbox.deliver("a thread needs your answer", "t2:input:q1", { kind: "needs_input", thread: "t2" });
		await r.relay().pass();
		expect(r.posts[0]!.message).toBe(`a thread needs your answer\n${DELIVERY_ID_LINE("t2:input:q1")}`);
	});
});

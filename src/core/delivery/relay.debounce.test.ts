/**
 * The debounce: idle news (a turn end, a note, a sweep) waits `debounceMs` for company and goes as ONE digest. Anything a person waits on
 * (needs_input, a failure, an answer) never waits, and an answer or any other kind held beside the news sends the whole batch at once.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { debouncing, type HeldItem } from "../decide/hold.ts";
import { createRelay } from "./relay.ts";

const { rig } = useCoreRelayFixtures(createRelay);
const MS = 180_000;
const held = (kind: string, queuedAt: number): HeldItem => ({
	deliveryId: `${kind}:${queuedAt}`,
	message: kind,
	queuedAt,
	kind,
});

describe("debouncing (pure)", () => {
	test("must wait: only news, the oldest younger than the window", () => {
		expect(debouncing([held("turn_ended", 1000), held("note", 2000), held("sweep", 3000)], 60_000, MS)).toBe(true);
	});
	test("must go: the oldest has waited the window", () => {
		expect(debouncing([held("turn_ended", 1000)], 1000 + MS, MS)).toBe(false);
	});
	test("must go: an answer, a transfer or any other kind beside the news sends the batch", () => {
		for (const kind of ["answer", "transfer", "alert_desk", "failed", "needs_input"])
			expect(debouncing([held("turn_ended", 1000), held(kind, 1500)], 2000, MS)).toBe(false);
	});
	test("must go: off (0 or absent), nothing held, an item stamped in the future", () => {
		expect(debouncing([held("note", 1000)], 2000, 0)).toBe(false);
		expect(debouncing([], 2000, MS)).toBe(false);
		expect(debouncing([held("note", 1_000_000)], 2000, MS)).toBe(false);
	});
});

describe("the relay's debounce", () => {
	test("must wait: an idle Steward is not woken by a lone turn end until the window ends; it goes then", async () => {
		const r = rig({ debounceMs: MS });
		r.outbox.deliver("turn end of t1", "t1:ended:r1:1", { kind: "turn_ended", thread: "t1" });
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		r.clock.t += MS - 1;
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		r.clock.t += 1;
		await r.relay().pass();
		expect(r.ids()).toEqual(["t1:ended:r1:1"]);
	});

	test("must merge: a note and turn ends inside the window go as one digest, one wake", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		await relay.pass();
		r.clock.t += 60_000;
		r.outbox.deliver("turn end of t1", "t1:ended:r1:2", { kind: "turn_ended", thread: "t1" });
		r.outbox.deliver("turn end of t2", "t2:ended:r1:3", { kind: "turn_ended", thread: "t2" });
		await relay.pass();
		expect(r.posts).toEqual([]);
		r.clock.t += MS;
		await relay.pass();
		expect(r.posts).toHaveLength(1);
		expect(r.posts[0]!.id.startsWith("digest:")).toBe(true);
		for (const id of ["note from t1", "turn end of t1", "turn end of t2"]) expect(r.posts[0]!.message).toContain(id);
	});

	test("the wait is logged once per batch, with how many are waiting", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("n", "note:a", { kind: "note", thread: "t1" });
		await relay.pass();
		await relay.pass();
		const logged = r.events.filter((e) => e.event === "wake-debounced");
		expect(logged).toHaveLength(1);
		expect(logged[0]!.data).toMatchObject({ held: 1, forMs: MS });
	});

	test("must wake at once: needs_input is never held, so it never waits", async () => {
		const r = rig({ debounceMs: MS });
		r.outbox.deliver("a thread needs your answer", "t1:input:q1", { kind: "needs_input", thread: "t1" });
		await r.relay().pass();
		expect(r.ids()).toEqual(["t1:input:q1"]);
	});

	test("must wake at once: an answer goes immediately, and takes the held news with it", async () => {
		const r = rig({ debounceMs: MS });
		const relay = r.relay();
		r.outbox.deliver("turn end of t1", "t1:ended:r1:1", { kind: "turn_ended", thread: "t1" });
		await relay.pass();
		expect(r.posts).toEqual([]);
		r.outbox.deliver("the principal answered", "answer:1", { kind: "answer", thread: "t1" });
		await relay.pass();
		expect(r.posts).toHaveLength(1);
		expect(r.posts[0]!.message).toContain("the principal answered");
		expect(r.posts[0]!.message).toContain("turn end of t1");
	});

	test("off: with no debounce a lone turn end goes at once, as it always did", async () => {
		const r = rig();
		r.outbox.deliver("turn end of t1", "t1:ended:r1:1", { kind: "turn_ended", thread: "t1" });
		await r.relay().pass();
		expect(r.ids()).toEqual(["t1:ended:r1:1"]);
	});
});

/**
 * Parked question cards (activeHold) and #108's carried news: a parked card is never carried as news while it waits, and once released it is
 * an ordinary immediate needs_input row that carries the held news in its own POST, bound delivered in the same commit as the wake.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const { rig } = useCoreRelayFixtures(createRelay);
const MS = 180_000;
const CARD = "t9:needs_input:req-1:1";
const park = (r: ReturnType<typeof rig>) =>
	r.store.wakes.hold({
		deliveryId: CARD,
		message: "a card in t9",
		queuedAt: r.clock.t,
		kind: "needs_input",
		thread: "t9",
		parked: { releaseAt: r.clock.t + MS, lastWriteAt: r.clock.t, server: "s", requestIds: ["req-1"] },
	});

describe("a parked card and the carried news", () => {
	test("while parked, an immediate wake carries the held news but never the parked card", async () => {
		const r = rig({ debounceMs: MS });
		park(r);
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		r.outbox.deliver("a failed run", "t3:failed:r9", { kind: "failed", thread: "t3" });
		await r.relay().pass();
		expect(r.ids()).toEqual(["t3:failed:r9"]);
		expect(r.posts[0]!.message).toContain("note from t1");
		expect(r.posts[0]!.message).not.toContain("a card in t9");
		expect(r.store.wakes.parked().map((h) => h.deliveryId)).toEqual([CARD]);
		expect(r.store.wakes.find("note:a")).toMatchObject({ status: "delivered" });
	});

	test("released, it is an immediate row that carries the held note in its own POST, one commit, nothing left behind", async () => {
		const r = rig({ debounceMs: MS });
		park(r);
		r.outbox.deliver("note from t1", "note:a", { kind: "note", thread: "t1" });
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		const row = r.store.wakes.unpark(CARD, r.clock.t, "released text for t9");
		expect(row).toMatchObject({ deliveryId: CARD, status: "pending" });
		await r.relay().pass();
		expect(r.ids()).toEqual([CARD]);
		const sent = r.posts[0]!.message;
		expect(sent.startsWith("released text for t9\n\n")).toBe(true);
		expect(sent).toContain("note from t1");
		expect(sent.endsWith(DELIVERY_ID_LINE(CARD))).toBe(true);
		expect(r.store.wakes.find(CARD)).toMatchObject({ message: "released text for t9", status: "delivered" });
		expect(r.store.wakes.find("note:a")).toMatchObject({ status: "delivered" });
		expect(r.store.wakes.held(null)).toEqual([]);
		expect(r.store.wakes.parked()).toEqual([]);
		r.clock.t += MS * 2;
		await r.relay().pass();
		expect(r.posts).toHaveLength(1);
	});
});

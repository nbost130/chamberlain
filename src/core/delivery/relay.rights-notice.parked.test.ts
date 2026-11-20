/**
 * Parked question cards (activeHold) and #108 round 4's rights notice: the tiny "rights-notice" wake is POSTed directly under an id of its own, never
 * queued, so a hold cannot park it; and a released card is an ordinary pending row that gets the notice (in its POST, or alone when it is near the
 * size bound) and the rights-undelivered fallback like any other.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsUndeliveredNotice, rightsUnreadNotice } from "../messages.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { stamp } = fx;
const inlineWorld = inlineWorldOf(fx);
type World = ReturnType<typeof inlineWorld>;

/** A card parked with the pointer stamp a held card carries, then released as the engine's tick does. */
function parkedThenReleased(r: World, id: string, text: string) {
	r.store.wakes.hold({
		deliveryId: id,
		message: text,
		queuedAt: r.clock.t,
		kind: "needs_input",
		thread: "t9",
		rights: [stamp],
		parked: { releaseAt: r.clock.t, lastWriteAt: r.clock.t, server: "s", requestIds: ["req-1"] },
	});
	return r.store.wakes.unpark(id, r.clock.t, text);
}

describe("a released card and round 4's rights notice", () => {
	for (const inline of [true, false])
		test(`rights unreadable, rightsInline ${inline ? "on" : "off"}: a card near the size bound gets the notice as a tiny wake first, and that wake is never parked or queued`, async () => {
			const r = inlineWorld({ inline });
			r.st.broken = true;
			const text = "x".repeat(23_850);
			expect(parkedThenReleased(r, "w1", text)).toMatchObject({ status: "pending", kind: "needs_input" });
			await r.relay().pass();
			expect(r.ids()).toEqual(["w1:rights-notice", "w1"]);
			expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
			expect(r.store.wakes.known("w1:rights-notice")).toBe(false);
			expect(r.store.wakes.parked()).toEqual([]);
			expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		});

	test("rights unreadable, a card with room: the notice rides in its own POST", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		parkedThenReleased(r, "w1", "small card");
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1"]);
		expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
	});

	test("the rights prerequisite dead-lettered: a released card is not stranded; it goes with the undelivered notice and the alarm", async () => {
		const r = inlineWorld({ inline: false });
		parkedThenReleased(r, "w1", "a card for t9");
		r.w.answer = async (id) => (id.includes(":rights-first:") ? { ok: false, status: 503 } : { ok: true, status: 202 });
		for (let i = 0; i < 12 && r.store.wakes.find("w1")?.status !== "delivered"; i++) {
			await r.relay().pass();
			r.clock.t += 5000;
		}
		expect(r.store.wakes.find("w1")?.status).toBe("delivered");
		expect(r.posts.filter((x) => x.id === "w1").at(-1)!.message).toContain(rightsUndeliveredNotice);
		expect(r.alarms).toContain("rights-undelivered");
	});

	test("round 5: a released card near the size bound whose notice wake keeps failing is not held at 0 attempts: after 3 failures the notice is prepended, with an alarm", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		const text = "x".repeat(23_850);
		parkedThenReleased(r, "w1", text);
		r.w.answer = async (id) => (id.endsWith(":rights-notice") ? { ok: false, status: 503 } : { ok: true, status: 202 });
		const relay = r.relay();
		for (let i = 0; i < 3; i++) {
			await relay.pass();
			r.clock.t += 2000;
			expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		}
		await relay.pass();
		expect(
			r.posts
				.filter((p) => p.id === "w1")
				.at(-1)!
				.message.startsWith(rightsUnreadNotice),
		).toBe(true);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		expect(r.alarms).toContain("rights-notice-undelivered");
		expect(r.store.wakes.parked()).toEqual([]);
	});

	test("a card still parked is left alone by the notice and the fallback: nothing is sent for it", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.store.wakes.hold({
			deliveryId: "w2",
			message: "a card in t9",
			queuedAt: r.clock.t,
			kind: "needs_input",
			thread: "t9",
			rights: [stamp],
			parked: { releaseAt: r.clock.t + 300_000, lastWriteAt: r.clock.t, server: "s", requestIds: ["req-1"] },
		});
		await r.relay().pass();
		expect(r.ids()).toEqual([]);
		expect(r.store.wakes.parked().map((h) => h.deliveryId)).toEqual(["w2"]);
	});
});

/**
 * Audit round 4. Item 1: a Steward row that goes without the rights ALWAYS carries the notice, in its own POST when it fits and as a tiny wake of
 * its own just before it when the row is near the size bound. Items 2 and 3: a dead-lettered rights prerequisite never strands the row that waited
 * on it (an answer, the hand-off): it goes with a notice and an alarm, and the next row tries the rights again.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsUndeliveredNotice, rightsUnreadNotice } from "../messages.ts";
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { H1, stamp } = fx;
const inlineWorld = inlineWorldOf(fx);

describe("the unreadable-rights notice always reaches the Steward (item 1)", () => {
	for (const inline of [true, false])
		test(`a row near the size bound (23,850 characters), rightsInline ${inline ? "on" : "off"}: the notice goes first as a tiny wake, then the row exactly as queued, every POST inside the bound`, async () => {
			const r = inlineWorld({ inline });
			r.st.broken = true;
			const row = "x".repeat(23_850);
			r.outbox.deliver(row, "w1", { kind: "needs_input", rights: [stamp] });
			await r.relay().pass();
			expect(r.ids()).toEqual(["w1:rights-notice", "w1"]);
			expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
			expect(r.posts[1]!.message).toBe(`${row}\n${DELIVERY_ID_LINE("w1")}`);
			for (const p of r.posts) expect(exceedsEncodedCap(p.message, p.id)).toBe(false);
			expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
			expect(r.alarms).toContain("rights-unreadable");
		});

	test("must skip: a row with room carries the notice in its own POST, as before", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.outbox.deliver("small", "w1", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1"]);
		expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
	});

	test("the wake never goes without either the rights or the notice: if the notice is not accepted the row waits, uses no attempt, and goes after it next pass", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.outbox.deliver("x".repeat(23_850), "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = async (id) => (id.endsWith(":rights-notice") ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1:rights-notice"]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		r.w.answer = async () => ({ ok: true, status: 202 });
		await r.relay().pass();
		expect(r.ids().at(-1)).toBe("w1");
		expect(r.store.wakes.find("w1")?.status).toBe("delivered");
	});
});

/** Refuses every rights prerequisite and accepts the rest, pass after pass, until the prerequisite is dead-lettered and the row still waits. */
async function deadLetterPrerequisite(r: ReturnType<typeof inlineWorld>, rowId: string) {
	r.w.answer = async (id) => (id.includes(":rights-first:") ? { ok: false, status: 503 } : { ok: true, status: 202 });
	const first = () => r.store.wakes.rows("all").find((w) => w.deliveryId.startsWith(`${rowId}:rights-first:`));
	for (let i = 0; i < 10 && first()?.status !== "dead_letter"; i++) {
		await r.relay().pass();
		r.clock.t += 5000;
	}
	expect(first()?.status).toBe("dead_letter");
	expect(r.store.wakes.find(rowId)).toMatchObject({ status: "pending", attempts: 0 });
}

describe("a dead-lettered rights prerequisite never strands the row that waited on it (items 2 and 3)", () => {
	const ROWS = [
		{ name: "an answer row", kind: "answer", id: "answer:item:Q-1" },
		{ name: "the hand-off wake", kind: "handoff", id: "steward-handoff:s1" },
		{ name: "a sweep", kind: "sweep", id: "sweep:1" },
	] as const;
	for (const p of ROWS)
		test(`${p.name}: goes with the notice and the alarm once the prerequisite is dead-lettered; the next row gets a fresh prerequisite and the rights`, async () => {
			const r = inlineWorld({ inline: false });
			r.outbox.deliver(`text of ${p.id}`, p.id, { kind: p.kind });
			await deadLetterPrerequisite(r, p.id);
			r.w.answer = async () => ({ ok: true, status: 202 });
			await r.relay().pass();
			const sent = r.posts.filter((x) => x.id === p.id).at(-1)!;
			expect(sent.message).toContain(rightsUndeliveredNotice);
			expect(r.store.wakes.find(p.id)).toMatchObject({ status: "delivered" });
			expect(r.alarms).toContain("rights-undelivered");
			expect(r.record()?.hash).toBeUndefined();
			// The next row tries the rights again, with a prerequisite of its own.
			r.outbox.deliver("the next one", "next:1", { kind: "sweep" });
			await r.relay().pass();
			const ids = r.ids();
			expect(ids.at(-2)).toContain("next:1:rights-first:");
			expect(ids.at(-1)).toBe("next:1");
			expect(r.record()).toMatchObject({ hash: H1 });
		});

	test("the same with the rights too large to ride inline (the standalone path of rightsInline on): the row goes with the notice", async () => {
		const r = inlineWorld({ block: "r".repeat(9_000) });
		r.outbox.deliver("x".repeat(23_000), "w1", { kind: "needs_input", rights: [stamp] });
		await deadLetterPrerequisite(r, "w1");
		r.w.answer = async () => ({ ok: true, status: 202 });
		await r.relay().pass();
		expect(r.posts.filter((x) => x.id === "w1").at(-1)!.message).toContain(rightsUndeliveredNotice);
		expect(r.store.wakes.find("w1")?.status).toBe("delivered");
	});
});

/**
 * Audit round 3. Item 5: a Steward row with NO rights stamp depends on the Steward holding the rights too, whichever producer made it (so no
 * producer has to stamp). Item 7: when the rights cannot be read the row is not held back: it goes with a notice and an alarm, and the read is
 * tried again with the next one.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsInlineHead, rightsUnreadNotice } from "../messages.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { H1 } = fx;
const inlineWorld = inlineWorldOf(fx);

/** Every producer that queues a Steward wake without a rights stamp, as it queues it: its kind and the delivery id it makes. */
const PRODUCERS = [
	{ name: "a thread's note (delivery/note.ts)", kind: "note", id: "note:abc123", thread: "t1" },
	{ name: "a decision-queue answer (items/questions-claim.ts)", kind: "answer", id: "answer:item:Q-1", thread: "t1" },
	{ name: "the hand-off wake (engine-core-work.ts)", kind: "handoff", id: "steward-handoff:s1" },
	{ name: "the routine sweep (engine-sweep.ts)", kind: "sweep", id: "sweep:1794940676968" },
	{ name: "the idle-parents check (engine-idle.ts)", kind: "sweep", id: "idle-parents:1794940676968" },
	{ name: "the prepare-pr check (engine-prepare-pr.ts)", kind: "sweep", id: "prepare-pr:1794940676968" },
	{ name: "the undelivered check (engine-undelivered.ts)", kind: "sweep", id: "undelivered:1794940676968" },
] as const;

describe("every producer's unstamped Steward row gets the rights check (item 5)", () => {
	for (const p of PRODUCERS) {
		test(`${p.name}: must send the rights with it when the record does not show them, and must skip once it does`, async () => {
			const r = inlineWorld();
			const meta = { kind: p.kind, ...("thread" in p ? { thread: p.thread } : {}) };
			r.outbox.deliver(`text of ${p.id}`, p.id, meta);
			await r.relay().pass();
			expect(r.ids()).toEqual([p.id]);
			expect(r.posts[0]!.message).toContain(rightsInlineHead);
			expect(r.record()).toMatchObject({ hash: H1 });
			r.outbox.deliver("a later one", `${p.id}:2`, meta);
			await r.relay().pass();
			expect(r.posts[1]!.message).toBe(`a later one\n${DELIVERY_ID_LINE(`${p.id}:2`)}`);
		});

		test(`${p.name}: with rightsInline off the standalone prerequisite goes first, then the row as queued`, async () => {
			const r = inlineWorld({ inline: false });
			r.outbox.deliver(`text of ${p.id}`, p.id, { kind: p.kind, ...("thread" in p ? { thread: p.thread } : {}) });
			await r.relay().pass();
			const ids = r.ids();
			expect(ids).toHaveLength(2);
			expect(ids[0]).toContain(`${p.id}:rights-first:`);
			expect(ids[1]).toBe(p.id);
			expect(r.posts[1]!.message).toBe(`text of ${p.id}\n${DELIVERY_ID_LINE(p.id)}`);
		});
	}

	test("the prerequisite itself is exempt: it is not given rights of its own, so it cannot recurse", async () => {
		const r = inlineWorld({ inline: false });
		r.outbox.deliver("text", "sweep:1", { kind: "sweep" });
		await r.relay().pass();
		expect(r.ids()).toHaveLength(2);
		expect(r.posts[0]!.message).not.toContain(rightsInlineHead);
	});
});

describe("rights that cannot be read never hold a row back (item 7)", () => {
	for (const stamped of [true, false])
		for (const inline of [true, false])
			test(`${stamped ? "a pointer-stamped" : "an unstamped"} row, rightsInline ${inline ? "on" : "off"}: goes with the notice and an alarm, uses one attempt, and the next row reads again`, async () => {
				const r = inlineWorld({ inline });
				r.st.broken = true;
				if (stamped) r.pointer("w1");
				else r.outbox.deliver("text of w1", "w1", { kind: "needs_input" });
				await r.relay().pass();
				expect(r.ids()).toEqual(["w1"]);
				expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
				expect(r.posts[0]!.message.endsWith(DELIVERY_ID_LINE("w1"))).toBe(true);
				expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
				expect(r.alarms).toContain("rights-unreadable");
				expect(r.record()).toBeUndefined();
				delete r.st.broken;
				r.pointer("w2");
				await r.relay().pass();
				expect(r.ids().at(-1)).toBe("w2");
				expect(r.record()).toMatchObject({ hash: H1 });
			});
});

/**
 * `rightsInline`: when a Steward row depends on rights the durable record does not show the Steward holds, the full block rides INSIDE that
 * row's own POST. No standalone rights wake is queued (each cost a whole Steward turn, 27 of 32 of them doing nothing), the stored row is never
 * edited, and the delivered commit writes the record exactly as a standalone full wake did.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsInlineHead } from "../messages.ts";
import { invalidateRights } from "../steward/rights-sent.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { H1, H2, BLOCK } = fx;
const inlineWorld = inlineWorldOf(fx);

describe("rightsInline", () => {
	test("must send: no record means the block rides in the row's own POST, as one wake, and the record is written", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1"]);
		expect(r.rightsRows()).toEqual([]);
		const sent = r.posts[0]!.message;
		expect(sent.startsWith("text of w1\n\n")).toBe(true);
		expect(sent).toContain(rightsInlineHead);
		expect(sent).toContain(BLOCK);
		expect(sent.endsWith(DELIVERY_ID_LINE("w1"))).toBe(true);
		expect(r.record()).toMatchObject({ steward: "steward-1", session: "s1", hash: H1 });
		expect(r.events.find((e) => e.event === "rights-inlined")?.data).toMatchObject({ deliveryId: "w1" });
	});

	test("the stored row is never edited: its text is what was queued", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ message: "text of w1", status: "delivered" });
	});

	test("must skip: the same Steward, session and hash with no compaction sends the next row exactly as queued", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toBe(`text of w2\n${DELIVERY_ID_LINE("w2")}`);
		expect(r.events.filter((e) => e.event === "rights-inlined")).toHaveLength(1);
	});

	test("must send: changed rights or rulings (a new hash) ride in the next row", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.st.hash = H2;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.record()).toMatchObject({ hash: H2 });
		expect(r.rightsRows()).toEqual([]);
	});

	test("must send: a new Steward session or thread gets the block in its first row", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.st.session = "s2";
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		r.st.steward = "steward-2";
		r.pointer("w3");
		await r.relay().pass();
		expect(r.posts[2]!.message).toContain(rightsInlineHead);
		expect(r.record()).toMatchObject({ steward: "steward-2", session: "s2" });
	});

	test("must send: after a compaction cleared the record, the next row carries the block again", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		invalidateRights(r.store);
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.record()).toMatchObject({ hash: H1, epoch: 1 });
	});

	test("a refused POST writes no record, so the retry carries the block again; still one wake per attempt", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		r.w.answer = async () => ({ ok: false, status: 503 });
		await r.relay().pass();
		expect(r.record()?.hash).toBeUndefined();
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1", "w1"]);
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.record()).toMatchObject({ hash: H1 });
	});

	test("must skip: a size that cannot be read now (every mid-turn wake) is no evidence the rights were lost, so no block rides", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		delete r.st.used;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toBe(`text of w2\n${DELIVERY_ID_LINE("w2")}`);
		expect(r.events.filter((e) => e.event === "rights-inlined")).toHaveLength(1);
	});

	test("must send: a compaction counted since the record was written (native or manual: T3 stores each as a turn item) carries the block, size readable or not", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.st.compactions = 5;
		delete r.st.used;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.events.filter((e) => e.event === "rights-inlined").at(-1)?.data?.reason).toContain("compaction");
		expect(r.record()).toMatchObject({ compactions: 5 });
		r.pointer("w3");
		await r.relay().pass();
		expect(r.posts[2]!.message).toBe(`text of w3\n${DELIVERY_ID_LINE("w3")}`);
	});

	test("must send: a large drop in size with no compaction item counted carries the block; a small dip does not", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.st.used = 85_000;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toBe(`text of w2\n${DELIVERY_ID_LINE("w2")}`);
		r.st.used = 79_999;
		r.pointer("w3");
		await r.relay().pass();
		expect(r.posts[2]!.message).toContain(rightsInlineHead);
		expect(r.events.filter((e) => e.event === "rights-inlined").at(-1)?.data?.reason).toContain("collapsed");
	});

	test("rightsInline off: a compaction counted sends the standalone prerequisite first, and an unreadable size does not", async () => {
		const r = inlineWorld({ inline: false });
		r.pointer("w1");
		await r.relay().pass();
		expect(r.ids()).toHaveLength(2);
		delete r.st.used;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.ids()).toHaveLength(3);
		r.st.compactions = 5;
		r.pointer("w3");
		await r.relay().pass();
		const ids = r.ids();
		expect(ids).toHaveLength(5);
		expect(ids[3]).toContain("w3:rights-first:");
		expect(ids[4]).toBe("w3");
		expect(r.posts[4]!.message).toBe(`text of w3\n${DELIVERY_ID_LINE("w3")}`);
		expect(r.record()).toMatchObject({ compactions: 5 });
	});

	test("with the flag off the standalone prerequisite is sent first, as before", async () => {
		const r = inlineWorld({ inline: false });
		r.pointer("w1");
		await r.relay().pass();
		expect(r.ids()).toHaveLength(2);
		expect(r.ids()[0]).toContain(":rights-first:");
		expect(r.posts[1]!.message).toBe(`text of w1\n${DELIVERY_ID_LINE("w1")}`);
	});
});

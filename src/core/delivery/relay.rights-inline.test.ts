/**
 * `rightsInline`: when a Steward row depends on rights the durable record does not show the Steward holds, the full block rides INSIDE that
 * row's own POST. No standalone rights wake is queued (each cost a whole Steward turn, 27 of 32 of them doing nothing), the stored row is never
 * edited, and the delivered commit writes the record exactly as a standalone full wake did.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { rightsInlineHead } from "../messages.ts";
import { invalidateRights, RIGHTS_SENT_KEY, rightsEpoch } from "../steward/rights-sent.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const { rig, H1, H2, stamp, BLOCK } = useCoreRelayFixtures(createRelay);

/** One Steward whose rights, session and thread the test moves; the full stamp carries the epoch it is composed under, as the engine's does. */
function inlineWorld(o: { inline?: boolean } = {}) {
	const store = memStore();
	const st = { steward: "steward-1", session: "s1", hash: H1 };
	const rightsNow = async () => ({
		...st,
		wake: (forId: string) => ({
			message: `[chamberlain] rights for ${forId}\n${BLOCK}`,
			text: `${BLOCK} (${st.hash.slice(0, 4)})`,
			stamp: { ...st, at: "now", used: 10, full: true as const, epoch: rightsEpoch(store) },
		}),
	});
	const r = rig({ store, rightsNow, rightsInline: o.inline ?? true });
	const record = () => store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
	const pointer = (id: string) => r.outbox.deliver(`text of ${id}`, id, { kind: "needs_input", rights: [stamp] });
	const rightsRows = () => store.wakes.rows("all").filter((w) => w.kind === "rights");
	return { ...r, st, record, pointer, rightsRows };
}

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

	test("with the flag off the standalone prerequisite is sent first, as before", async () => {
		const r = inlineWorld({ inline: false });
		r.pointer("w1");
		await r.relay().pass();
		expect(r.ids()).toHaveLength(2);
		expect(r.ids()[0]).toContain(":rights-first:");
		expect(r.posts[1]!.message).toBe(`text of w1\n${DELIVERY_ID_LINE("w1")}`);
	});
});

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
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const { rig, H1, H2, stamp, BLOCK } = useCoreRelayFixtures(createRelay);

/** One Steward whose rights, session and thread the test moves; the full stamp carries the epoch it is composed under, as the engine's does. */
function inlineWorld(o: { inline?: boolean; block?: string } = {}) {
	const store = memStore();
	const st: { steward: string; session: string; hash?: string; used?: number } = {
		steward: "steward-1",
		session: "s1",
		hash: H1,
		used: 100_000,
	};
	const rightsNow = async () => ({
		...st,
		wake: (forId: string) => ({
			message: `[chamberlain] rights for ${forId}\n${BLOCK}`,
			text: st.hash === undefined ? "the rights cannot be read" : `${o.block ?? BLOCK} (${st.hash.slice(0, 4)})`,
			...(st.hash === undefined
				? {}
				: {
						stamp: {
							steward: st.steward,
							session: st.session,
							hash: st.hash,
							at: "now",
							...(st.used !== undefined ? { used: st.used } : {}),
							full: true as const,
							epoch: rightsEpoch(store),
						},
					}),
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

	test("must send: a size that cannot be read now (the newest turn has no usage: what a native or manual compaction looks like) carries the block", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		delete r.st.used;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.events.filter((e) => e.event === "rights-inlined").at(-1)?.data?.reason).toContain("cannot be read");
	});

	test("must send: a context under the record's high-water mark (a compaction the daemon did not make) carries the block, whatever session, hash and epoch say", async () => {
		const r = inlineWorld();
		r.pointer("w1");
		await r.relay().pass();
		r.st.used = 99_999;
		r.pointer("w2");
		await r.relay().pass();
		expect(r.posts[1]!.message).toContain(rightsInlineHead);
		expect(r.events.filter((e) => e.event === "rights-inlined").at(-1)?.data?.reason).toContain("shrank");
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

describe("a queued row that holds a full block is not delivered as current when the rights in force have moved (audit round 1, finding 2)", () => {
	const oldFull = { steward: "steward-1", session: "s1", hash: H1, at: "t0", used: 100_000, full: true as const };
	const queue = (r: ReturnType<typeof inlineWorld>, id = "f1", text = "old block text") =>
		r.outbox.deliver(text, id, { kind: "needs_input", rights: [oldFull] });

	test("must send the current rights: the rights changed before delivery, so they ride after the old block and the record names the NEW hash", async () => {
		const r = inlineWorld();
		queue(r);
		r.st.hash = H2;
		await r.relay().pass();
		const sent = r.posts[0]!.message;
		expect(sent.startsWith("old block text\n\n")).toBe(true);
		expect(sent).toContain(rightsInlineHead);
		expect(sent).toContain(`(${H2.slice(0, 4)})`);
		expect(sent.endsWith(DELIVERY_ID_LINE("f1"))).toBe(true);
		expect(r.record()).toMatchObject({ hash: H2 });
		expect(r.store.wakes.find("f1")).toMatchObject({ message: "old block text", status: "delivered" });
	});

	test("the same holds with rightsInline off: a stale block is never delivered bare", async () => {
		const r = inlineWorld({ inline: false });
		queue(r);
		r.st.hash = H2;
		await r.relay().pass();
		expect(r.ids()).toEqual(["f1"]);
		expect(r.posts[0]!.message).toContain(`(${H2.slice(0, 4)})`);
		expect(r.record()).toMatchObject({ hash: H2 });
	});

	test("must send: rights that cannot be read now are said so after the old block, and no record is written from the old one", async () => {
		const r = inlineWorld();
		queue(r);
		delete r.st.hash;
		await r.relay().pass();
		expect(r.posts[0]!.message).toContain("the rights cannot be read");
		expect(r.record()?.hash).toBeUndefined();
	});

	test("must skip: a full block that IS the current rights goes exactly as queued and writes its own record", async () => {
		const r = inlineWorld();
		queue(r);
		await r.relay().pass();
		expect(r.posts[0]!.message).toBe(`old block text\n${DELIVERY_ID_LINE("f1")}`);
		expect(r.record()).toMatchObject({ hash: H1 });
		expect(r.events.some((e) => e.event === "rights-inlined")).toBe(false);
	});
});

describe("the size bound is checked on what is POSTed, the rights included (audit round 1, finding 5)", () => {
	const ROW = "x".repeat(23_000);
	const BIG = "r".repeat(2_000);

	test("must send standalone: a row that fits alone but not with the block inline gets the block as a prerequisite, and nothing POSTed is over the bound", async () => {
		const r = inlineWorld({ block: BIG });
		const big = r.outbox.deliver(ROW, "o2", { kind: "needs_input", rights: [stamp] });
		expect(big).toBe("queued");
		await r.relay().pass();
		const ids = r.ids();
		expect(ids.at(-1)).toBe("o2");
		expect(ids.some((id) => id.startsWith("o2:rights-first:"))).toBe(true);
		for (const p of r.posts) expect(exceedsEncodedCap(p.message, p.id)).toBe(false);
		expect(r.posts.at(-1)!.message).toBe(`${ROW}\n${DELIVERY_ID_LINE("o2")}`);
		expect(r.events.some((e) => e.event === "rights-inline-oversized")).toBe(true);
		expect(r.record()).toMatchObject({ hash: H1 });
	});

	for (const kind of ["needs_input", "failed", "message"])
		test(`must not be lost (${kind}): a row with a stale full block whose replacement does not fit inline gets a standalone prerequisite, then goes unchanged`, async () => {
			const r = inlineWorld({ block: "r".repeat(9_000) });
			const row = "x".repeat(15_500);
			r.outbox.deliver(row, "o3", {
				kind,
				rights: [{ steward: "steward-1", session: "s1", hash: H1, at: "t0", used: 100_000, full: true }],
			});
			r.st.hash = H2;
			await r.relay().pass();
			expect(r.store.wakes.find("o3")?.status).toBe("delivered");
			const ids = r.ids();
			expect(ids).toHaveLength(2);
			expect(ids[0]).toContain("o3:rights-first:");
			expect(ids[1]).toBe("o3");
			expect(r.posts[1]!.message.startsWith(row)).toBe(true);
			expect(r.posts[1]!.message).not.toContain(rightsInlineHead);
			for (const p of r.posts) expect(exceedsEncodedCap(p.message, p.id)).toBe(false);
			// The record names the CURRENT rights, never the stale block the row carried.
			expect(r.record()).toMatchObject({ hash: H2 });
			expect(r.alarms).toEqual([]);
		});

	test("dead-lettered only when the row by itself is over the bound, as before this PR", async () => {
		const r = inlineWorld();
		r.outbox.deliver("x".repeat(24_500), "o5", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("o5")?.status).toBe("dead_letter");
	});

	test("must skip: a row that fits with the block inline still goes in one wake", async () => {
		const r = inlineWorld({ block: BIG });
		r.outbox.deliver("x".repeat(10_000), "o4", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.ids()).toEqual(["o4"]);
		expect(r.posts[0]!.message).toContain(rightsInlineHead);
	});
});

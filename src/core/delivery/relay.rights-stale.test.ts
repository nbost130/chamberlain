/**
 * A queued row that holds a full block is never delivered as current when the rights in force have moved (audit round 1, finding 2), the size bound
 * counts the rights that ride in the POST (finding 5), and a row is never lost because the current rights do not fit beside it (round 2, N1).
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsInlineHead } from "../messages.ts";
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { H1, H2, stamp } = fx;
const inlineWorld = inlineWorldOf(fx);

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

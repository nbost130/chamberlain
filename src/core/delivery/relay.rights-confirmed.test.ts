/**
 * Audit round 5. Item 1: one rule: current rights that cannot be CONFIRMED at send time never count as delivered. The wake carries the hold
 * notice (and says its own rights block is possibly out of date), and the rights record is not written as current. Item 2: a notice wake that keeps
 * failing never holds the row at 0 attempts for ever: after N failures or 15 minutes it is prepended to the row's own text, with an alarm.
 */
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { inlineWorldOf } from "../../testing/core-rights-inline-fixtures.ts";
import { rightsStaleCopyNote, rightsStaleNote, rightsUnreadNotice } from "../messages.ts";
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { createRelay } from "./relay.ts";

const fx = useCoreRelayFixtures(createRelay);
const { H1, H2, stamp } = fx;
const inlineWorld = inlineWorldOf(fx);
const OLD_FULL = { steward: "steward-1", session: "s1", hash: H1, at: "t0", used: 100_000, full: true as const };

describe("current rights that cannot be confirmed never count as delivered (item 1)", () => {
	for (const inline of [true, false])
		test(`a stale full copy whose replacement read fails at send time, rightsInline ${inline ? "on" : "off"}: the notice rides with it, the copy is marked possibly out of date, and no record is written`, async () => {
			const r = inlineWorld({ inline, block: "r".repeat(9_000) });
			r.outbox.deliver("x".repeat(15_500), "w1", { kind: "needs_input", rights: [OLD_FULL] });
			r.st.hash = H2;
			// The first read (the staleness check) works; the second (the standalone replacement) throws.
			r.st.failFromRead = 2;
			await r.relay().pass();
			const row = r.posts.filter((p) => p.id === "w1").at(-1)!;
			expect(row.message).toContain(rightsUnreadNotice);
			expect(row.message).toContain(rightsStaleCopyNote);
			expect(row.message).not.toContain(rightsStaleNote);
			expect(r.store.wakes.find("w1")?.status).toBe("delivered");
			expect(r.record()?.hash).toBeUndefined();
			expect(r.alarms).toContain("rights-unreadable");
		});

	test("must skip: when the replacement read works, the standalone prerequisite goes first and the record names the current rights", async () => {
		const r = inlineWorld({ block: "r".repeat(9_000) });
		r.outbox.deliver("x".repeat(15_500), "w1", { kind: "needs_input", rights: [OLD_FULL] });
		r.st.hash = H2;
		await r.relay().pass();
		expect(r.ids()).toHaveLength(2);
		expect(r.posts[1]!.message).toContain(rightsStaleNote);
		expect(r.record()).toMatchObject({ hash: H2 });
	});

	test("a stale full copy whose FIRST read fails carries the notice and the possibly-out-of-date mark, and no record is written either", async () => {
		const r = inlineWorld();
		r.outbox.deliver("small", "w1", { kind: "needs_input", rights: [OLD_FULL] });
		r.st.broken = true;
		await r.relay().pass();
		expect(r.posts[0]!.message).toContain(rightsUnreadNotice);
		expect(r.posts[0]!.message).toContain(rightsStaleCopyNote);
		expect(r.record()?.hash).toBeUndefined();
	});
});

describe("a notice wake that keeps failing never holds the row at 0 attempts (item 2)", () => {
	const NEAR_CAP = "x".repeat(23_850);
	const noticeRefused = async (id: string) =>
		id.endsWith(":rights-notice") ? { ok: false, status: 503 } : { ok: true, status: 202 };

	test("after the default 3 failures the notice is prepended to the row's own POST, past the soft bound, with an alarm; the row is delivered", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.outbox.deliver(NEAR_CAP, "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = noticeRefused;
		const relay = r.relay();
		for (let i = 0; i < 3; i++) {
			await relay.pass();
			r.clock.t += 2000;
			expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		}
		await relay.pass();
		expect(r.ids().filter((id) => id.endsWith(":rights-notice"))).toHaveLength(3);
		const row = r.posts.filter((p) => p.id === "w1").at(-1)!;
		expect(row.message.startsWith(rightsUnreadNotice)).toBe(true);
		expect(row.message).toContain(NEAR_CAP);
		expect(exceedsEncodedCap(row.message, "w1")).toBe(true);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		expect(r.alarms).toContain("rights-notice-undelivered");
	});

	test("after 15 minutes even one failure is enough", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.outbox.deliver(NEAR_CAP, "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = noticeRefused;
		const relay = r.relay();
		await relay.pass();
		expect(r.store.wakes.find("w1")?.attempts).toBe(0);
		r.clock.t += 16 * 60_000;
		await relay.pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		expect(r.alarms).toContain("rights-notice-undelivered");
	});

	test("the count is configurable: with noticeRetries 1 the first failure is enough", async () => {
		const r = inlineWorld({ noticeRetries: 1 });
		r.st.broken = true;
		r.outbox.deliver(NEAR_CAP, "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = noticeRefused;
		const relay = r.relay();
		await relay.pass();
		r.clock.t += 2000;
		await relay.pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
	});

	test("if even the prepended POST is refused the row takes its normal attempts and is dead-lettered: it never sits at 0 attempts", async () => {
		const r = inlineWorld({ noticeRetries: 1 });
		r.st.broken = true;
		r.outbox.deliver(NEAR_CAP, "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = async () => ({ ok: false, status: 503 });
		const relay = r.relay();
		for (let i = 0; i < 12 && r.store.wakes.find("w1")?.status === "pending"; i++) {
			await relay.pass();
			r.clock.t += 5 * 60_000;
		}
		expect(r.store.wakes.find("w1")?.status).toBe("dead_letter");
		expect(r.store.wakes.find("w1")?.attempts).toBeGreaterThan(0);
	});

	test("must skip: a notice wake that is accepted raises nothing and the row goes as queued", async () => {
		const r = inlineWorld();
		r.st.broken = true;
		r.outbox.deliver(NEAR_CAP, "w1", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.ids()).toEqual(["w1:rights-notice", "w1"]);
		expect(r.alarms).not.toContain("rights-notice-undelivered");
	});
});

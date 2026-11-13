/**
 * Receiver-side idempotency (audit, "Also"). The webhook cannot de-duplicate, so every wake carries its delivery id, in the POST body and
 * as the last line of its text, the same on every retry; and the Steward's templates say to treat a delivery id it has already handled as a
 * repeat. The windows in which a wake can arrive twice are in docs/ARCHITECTURE.md; this is what makes a second arrival recognisable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { memStore } from "../testing/store.ts";
import { testRelayLock } from "../testing/lock.ts";
import { createOutbox, DELIVERY_ID_LINE, withDeliveryId } from "./deliver.ts";
import { createRelay } from "./relay.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (f: string) => readFileSync(`${ROOT}${f}`, "utf8");
const lastLine = (m: string) => m.split("\n").at(-1)!;

function rig(status = () => 202) {
	const sent: { deliveryId: string; message: string }[] = [];
	const store = memStore();
	const clock = { t: 1_000_000 };
	const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
	const relay = createRelay({ store, lock: testRelayLock(store), gate: () => "idle", log: () => {}, alarm: () => {}, now: () => clock.t, retryAfterMs: () => 0,
		wake: { ready: () => true, send: async (deliveryId, message) => { sent.push({ deliveryId, message }); const s = status(); return { ok: s < 300, status: s }; } } });
	return { sent, store, outbox, relay, clock };
}

describe("every wake carries its delivery id as the last line of its text", () => {
	test("a first send: the text the transport receives ends with the same id it receives beside it", async () => {
		const r = rig();
		r.outbox.deliver("[chamberlain] needs_input: thread X waits.", "t1:needs_input:req-1:99", { kind: "needs_input", thread: "t1" });
		await r.relay.pass();
		expect(r.sent).toHaveLength(1);
		expect(lastLine(r.sent[0]!.message)).toBe(DELIVERY_ID_LINE("t1:needs_input:req-1:99"));
		expect(r.sent[0]!.message.startsWith("[chamberlain] needs_input: thread X waits.\n")).toBe(true);
	});

	test("every attempt says the same thing: the id and the text are frozen in the row, so a repeat reads as a repeat", async () => {
		let n = 0;
		const r = rig(() => (++n < 3 ? 503 : 202));
		r.outbox.deliver("[chamberlain] answer: item Q-abcd1", "answer:item:Q-abcd1", { kind: "answer" });
		for (let i = 0; i < 3; i++) await r.relay.pass();
		expect(r.sent).toHaveLength(3);
		expect(new Set(r.sent.map((s) => s.message)).size).toBe(1);
		expect(new Set(r.sent.map((s) => s.deliveryId))).toEqual(new Set(["answer:item:Q-abcd1"]));
		expect(lastLine(r.sent[2]!.message)).toBe(DELIVERY_ID_LINE("answer:item:Q-abcd1"));
	});

	test("a held wake composed alone, and a digest, carry theirs too (a digest still names each member's)", async () => {
		const r = rig();
		r.outbox.deliver("[chamberlain] turn_ended: A finished", "turn:A:1", { kind: "turn_ended", thread: "A" });
		await r.relay.pass();
		expect(r.sent[0]!.deliveryId).toBe("turn:A:1");
		expect(lastLine(r.sent[0]!.message)).toBe(DELIVERY_ID_LINE("turn:A:1"));
		r.clock.t += 60_000;
		r.outbox.deliver("[chamberlain] sweep: x", "sweep:7", { kind: "sweep" });
		r.outbox.deliver("[chamberlain] sweep: y", "sweep:8", { kind: "sweep" });
		await r.relay.pass();
		const digest = r.sent.at(-1)!;
		expect(lastLine(digest.message)).toBe(DELIVERY_ID_LINE(digest.deliveryId));
		for (const id of ["sweep:7", "sweep:8"]) expect(digest.message).toContain(`deliveryId: ${id}`);
	});

	test("withDeliveryId adds the line once, and is the identity for a text that has it", () => {
		const once = withDeliveryId("hello", "id-1");
		expect(once).toBe(`hello\n${DELIVERY_ID_LINE("id-1")}`);
		expect(withDeliveryId(once, "id-1")).toBe(once);
		expect(withDeliveryId(once, "id-2")).toBe(`${once}\n${DELIVERY_ID_LINE("id-2")}`);
	});
});

describe("the Steward's templates and the delivery docs say a repeated delivery id is a repeat", () => {
	const RULE = /delivery id/i;
	for (const f of [".claude/commands/steward-wake.md", "docs/steward-wake-prompt.md", "docs/steward-sweep-prompt.md"]) {
		test(`${f} names the delivery id and says to treat a second one as a repeat`, () => {
			const text = read(f);
			expect(text).toMatch(RULE);
			expect(text).toMatch(/repeat/i);
			expect(text).toMatch(/already handled/i);
		});
	}
	test("the wake task's prompt passes the delivery id through from the webhook body", () => {
		expect(read("docs/steward-wake-prompt.md")).toContain("{{body.deliveryId}}");
	});
	test("the docs on delivery guarantees state the rule, the windows, and where the id travels", () => {
		const arch = read("docs/ARCHITECTURE.md");
		const section = arch.slice(arch.indexOf("## Delivery guarantees and the windows that remain"), arch.indexOf("## Where state lives"));
		for (const part of ["delivery id", "repeat", "no row is POSTed more than `maxAttempts` times between explicit retries", "The windows that remain, exactly", "owed", "dead_letter"]) expect(section).toContain(part);
		expect(read("README.md")).toMatch(/delivery id/);
	});
});

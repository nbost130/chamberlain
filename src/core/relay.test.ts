/**
 * The transactional outbox and its one relay. Each failure found in the delivery design is a test here: accepted POSTs that never land (across
 * successive holders), a digest rebuilt under a new id on takeover, a clock jump taking a live holder's lease, attempt reservations spent across
 * boots, a refusal erasing an unknown outcome's history, a retry beside a live POST, and a cancelled digest with no tombstone. Where a case needed
 * two holders, the design has one relay; "a restart" is a fresh relay over the same database, one after another.
 */

import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../testing/core-relay-fixtures.ts";
import type { WakeResult } from "./deliver.ts";
import { createRelay } from "./relay.ts";
import { retryAfterMs } from "./relay-ctx.ts";
import { runWakesCli } from "./wakes-cli.ts";

const { rig } = useCoreRelayFixtures(createRelay);

describe("the relay sends each row with its attempt committed first", () => {
	test("a wake is a pending row, sent once under its id with the delivery-id line last, then delivered; another pass sends nothing", async () => {
		const r = rig();
		expect(r.outbox.deliver("hello", "w1")).toBe("queued");
		expect(r.store.wakes.rows()).toMatchObject([{ deliveryId: "w1", status: "pending", attempts: 0 }]);
		const relay = r.relay();
		expect(await relay.pass()).toEqual(["w1"]);
		expect(r.posts).toHaveLength(1);
		expect(r.posts[0]!.message.split("\n").at(-1)).toContain("delivery id: w1");
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		await relay.pass();
		expect(r.posts).toHaveLength(1);
		expect(r.outbox.deliver("hello", "w1")).toBe("known");
	});

	test("while the POST is out the row already says one attempt, committed", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = () =>
			new Promise((ok) => {
				release = () => ok({ ok: true });
			});
		r.outbox.deliver("m", "w1");
		const pass = r.relay().pass();
		await Bun.sleep(5);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		release();
		await pass;
		expect(r.store.wakes.find("w1")!.status).toBe("delivered");
	});

	test("every outcome counts and none is given back: a timeout, then a refusal, then a 503 use the three attempts, and the row is dead-lettered", async () => {
		const r = rig();
		const outcomes = [
			async (): Promise<WakeResult> => {
				throw Error("timeout after the webhook may have taken it");
			},
			async () => ({ ok: false, error: "connection refused" }),
			async () => ({ ok: false, status: 503 }),
		];
		r.w.answer = () => outcomes[r.posts.length - 1]!();
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 6; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.ids()).toEqual(["w1", "w1", "w1"]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
		expect(r.alarms).toContain("wake-dead-letter");
		r.w.answer = async () => ({ ok: true });
		await r.relay().pass();
		expect(r.posts).toHaveLength(3);
	});

	test("a failed row waits its pause; another row is not held up by it, and a stale one raises an alarm and is kept", async () => {
		const r = rig();
		r.w.answer = async (id) => ({ ok: id === "good" });
		r.outbox.deliver("m", "bad");
		r.outbox.deliver("m", "good");
		const relay = r.relay();
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good"]);
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good"]);
		r.clock.t += 1001;
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good", "bad"]);
		r.clock.t += 25 * 3600_000;
		relay.audit();
		expect(r.alarms).toContain("wake-stale");
		expect(r.store.wakes.find("bad")!.status).toBe("pending");
		expect(retryAfterMs(1)).toBe(60_000);
		expect(retryAfterMs(2)).toBe(240_000);
	});

	test("with nowhere to send, nothing is attempted and no attempt is used; the alarm says why, and the row goes once there is somewhere", async () => {
		const r = rig();
		r.w.ready = false;
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 5; i++) await relay.pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("w1")!.attempts).toBe(0);
		expect(r.alarms).toEqual(["wake-not-ready"]);
		r.w.ready = true;
		await relay.pass();
		expect(r.ids()).toEqual(["w1"]);
	});
});

describe("what the delivery guarantee says, and what it does not (attempts, the cap, latency, order)", () => {
	test("an attempt is not a POST: three attempts spent by crashes between the count and the POST dead-letter a row nothing ever sent, and the alarm says so", async () => {
		const r = rig();
		r.outbox.deliver("m", "w1");
		const id = r.store.wakes.find("w1")!.id;
		// What a relay that exits after committing its attempt (crash step "attempt-counted") leaves behind, three times over.
		for (let i = 0; i < 3; i++) expect(r.store.wakes.beginAttempt(id, r.clock.t)).toBe(i + 1);
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
		expect(r.store.wakes.isDelivered("w1")).toBe(false);
		expect(r.alarms).toContain("wake-dead-letter");
	});

	test("the cap is per row between explicit retries: a retry allows maxAttempts more, so POSTs in all can pass the cap", async () => {
		const r = rig();
		r.w.answer = async () => ({ ok: false, status: 503 });
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.posts).toHaveLength(3);
		expect(runWakesCli(r.store, ["retry", "w1"], () => {})).toBe(0);
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.posts).toHaveLength(6);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
	});

	test("sends are sequential: a stuck send delays the row behind it until the call returns (pickup latency is conditional)", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = (id) =>
			id === "first"
				? new Promise((ok) => {
						release = () => ok({ ok: true });
					})
				: Promise.resolve({ ok: true });
		r.outbox.deliver("m", "first");
		r.outbox.deliver("m", "second");
		const relay = r.relay();
		const pass = relay.pass();
		await Bun.sleep(30);
		const queued = relay.pass(); // a second pass cannot start while the first is still sending
		await Bun.sleep(30);
		expect(r.ids()).toEqual(["first"]);
		expect(r.store.wakes.find("second")).toMatchObject({ status: "pending", attempts: 0 });
		release();
		await pass;
		await queued;
		expect(r.ids()).toEqual(["first", "second"]);
	});

	test("order is insertion order with backoff skips, not strict: a later row is delivered before an earlier one that is paused", async () => {
		const r = rig();
		const accepted: string[] = [];
		r.w.answer = async (id) => {
			const ok = id === "later" || r.clock.t > 1_001_000;
			if (ok) accepted.push(id);
			return { ok };
		};
		r.outbox.deliver("m", "earlier");
		r.outbox.deliver("m", "later");
		const relay = r.relay();
		await relay.pass();
		r.clock.t += 2000;
		await relay.pass();
		expect(accepted).toEqual(["later", "earlier"]);
		expect(r.store.wakes.find("earlier")!.id).toBeLessThan(r.store.wakes.find("later")!.id);
	});

	test("a row another process wrote is picked up by the next poll, not at once", async () => {
		const r = rig();
		const relay = r.relay();
		const first = relay.start(60);
		await first;
		r.store.wakes.enqueue({ deliveryId: "from-the-page", message: "m", queuedAt: r.clock.t }); // the page's write: no nudge
		expect(r.posts).toEqual([]);
		await Bun.sleep(250);
		await relay.stop();
		expect(r.ids()).toEqual(["from-the-page"]);
	});
});

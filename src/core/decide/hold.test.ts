/**
 * One wake at a time into the Steward's thread: turn-end and sweep wakes are held while it is busy, and the relay composes everything held
 * into one digest row when it is idle. Every other wake (a question, a failure, an answer) is a pending row at once. Producers write rows
 * (the daemon's outbox, the page); the relay sends them, with a clock and a Steward gate the test moves by hand.
 */

import { describe, expect, test } from "bun:test";
import { useCoreHoldFixtures } from "../../testing/core-hold-fixtures.ts";
import { fetchWake } from "../../testing/wake.ts";
import { finalSendMessage } from "../delivery/deliver.ts";
import { createRelay } from "../delivery/relay.ts";
import { composeWake, HOLD_CEILING_MS, observe } from "./hold.ts";

const { MIN, TE, SWEEP, world } = useCoreHoldFixtures(createRelay, fetchWake);

describe("held while the Steward is busy", () => {
	test("a running, queued or unreadable Steward gets no turn end or sweep: each is held, and a second write of a held id changes nothing", async () => {
		for (const gate of ["busy", "unknown"] as const) {
			const x = world();
			const relay = x.relay();
			x.w.gate = gate;
			expect(x.deliver("[chamberlain] turn_ended: A", "k1", TE("A"))).toBe("queued");
			expect(x.deliver("[chamberlain] sweep", "sweep:1", SWEEP)).toBe("queued");
			expect(await relay.pass()).toEqual([]);
			expect(x.deliver("[chamberlain] turn_ended: A", "k1", TE("A"))).toBe("known");
			expect(x.held()).toEqual(["k1", "sweep:1"]);
			expect(x.store().wakes.known("k1")).toBe(true);
			expect(x.w.accepted).toHaveLength(0);
		}
	});
});

describe("one digest when it goes idle", () => {
	test("everything held goes out as ONE wake, each item with its text and its delivery ID, and all of it is delivered together", async () => {
		const x = world();
		const relay = x.relay();
		x.w.gate = "busy";
		x.deliver("[chamberlain] turn_ended: thread A finished.", "turn:A:1", TE("A"));
		x.deliver("[chamberlain] turn_ended: thread B finished.", "turn:B:1", TE("B"));
		x.deliver("[chamberlain] sweep: PR 12 is ready.", "sweep:1", SWEEP);
		x.advance(5 * MIN);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(0);
		x.w.gate = "idle";
		expect(await relay.pass()).toEqual(["turn:A:1", "turn:B:1", "sweep:1"]);
		expect(x.w.accepted).toHaveLength(1);
		const wake = x.w.accepted[0]!;
		expect(wake.deliveryId).toMatch(/^digest:[0-9a-f]{16}$/);
		for (const id of ["turn:A:1", "turn:B:1", "sweep:1"]) expect(wake.message).toContain(`deliveryId: ${id}`);
		for (const text of ["thread A finished.", "thread B finished.", "PR 12 is ready."])
			expect(wake.message).toContain(text);
		expect(wake.message).toContain("3 wakes were held");
		expect(wake.message).toContain("held 5 min");
		for (const id of ["turn:A:1", "turn:B:1", "sweep:1", wake.deliveryId])
			expect(x.store().wakes.isDelivered(id)).toBe(true);
		expect(x.held()).toEqual([]);
		expect(x.store().wakes.rows()).toEqual([]);
		// Nothing more goes out, and a delivered item is never queued again, by any producer.
		expect(await relay.pass()).toEqual([]);
		expect(x.deliver("again", "turn:A:1", TE("A"))).toBe("known");
		expect(x.w.accepted).toHaveLength(1);
	});

	test("an idle Steward with one turn end gets that wake as itself, on the relay's next pass", async () => {
		const x = world();
		x.deliver("[chamberlain] turn_ended: B", "turn:B:1", TE("B"));
		await x.relay().pass();
		expect(x.w.accepted).toEqual([
			{ deliveryId: "turn:B:1", message: finalSendMessage("[chamberlain] turn_ended: B", "turn:B:1") },
		]);
	});

	test("a second wake right behind the first waits until T3 has had time to show the first", async () => {
		const x = world();
		const relay = x.relay();
		x.deliver("one", "k1", TE("A"));
		await relay.pass();
		x.advance(5_000);
		x.deliver("two", "k2", TE("B"));
		expect(await relay.pass()).toEqual([]);
		x.advance(40_000);
		expect(await relay.pass()).toEqual(["k2"]);
		expect(x.w.accepted.map((a) => a.deliveryId)).toEqual(["k1", "k2"]);
	});

	test("a post that fails leaves the composed row pending, and it goes again, the same, after its pause", async () => {
		const x = world();
		const relay = x.relay();
		x.deliver("a", "k1", TE("A"));
		x.deliver("b", "k2", TE("B"));
		x.w.status = 503;
		expect(await relay.pass()).toEqual([]);
		expect(x.held()).toEqual([]);
		expect(x.store().wakes.find("k1")).toMatchObject({ status: "pending", attempts: 1 });
		x.w.status = 202;
		expect(await relay.pass()).toEqual([]);
		x.advance(MIN);
		expect(await relay.pass()).toEqual(["k1", "k2"]);
		expect(x.w.accepted).toHaveLength(1);
	});
});

describe("repeats while held: the latest per thread and kind", () => {
	test("three turn_ended for one thread keep the latest and say how many were folded; other threads and sweeps are untouched", async () => {
		const x = world();
		const relay = x.relay();
		x.w.gate = "busy";
		x.deliver("TEXT turn_ended A first", "t:A:1", TE("A"));
		x.advance(MIN);
		x.deliver("TEXT turn_ended B only", "t:B:1", TE("B"));
		x.advance(MIN);
		x.deliver("TEXT turn_ended A second", "t:A:2", TE("A"));
		x.deliver("TEXT turn_ended C only", "t:C:1", TE("C"));
		x.advance(MIN);
		x.deliver("TEXT turn_ended A third", "t:A:3", TE("A"));
		x.deliver("TEXT sweep one", "sweep:1", SWEEP);
		x.deliver("TEXT sweep two", "sweep:2", SWEEP);
		x.w.gate = "idle";
		x.advance(MIN);
		await relay.pass();
		const m = x.w.accepted[0]!.message;
		expect(x.w.accepted).toHaveLength(1);
		expect(m).toContain("TEXT turn_ended A third");
		expect(m).not.toContain("TEXT turn_ended A first");
		expect(m).not.toContain("TEXT turn_ended A second");
		for (const kept of ["TEXT turn_ended B only", "TEXT turn_ended C only", "TEXT sweep one", "TEXT sweep two"])
			expect(m).toContain(kept);
		expect(m).toContain("7 wakes were held");
		expect(m).toContain("2 earlier wakes about the same thread and kind were folded");
		expect(m).toContain("folded 2 earlier turn_ended wakes for this thread (t:A:1, t:A:2)");
		expect(m).toContain("item 5 of 5");
		// The folded wakes are bound to the digest and delivered with it: not one of them is sent again.
		expect(x.store().wakes.find("t:A:1")).toMatchObject({ folded: 2, status: "delivered" });
		for (const id of ["t:A:1", "t:A:2", "t:A:3", "t:B:1", "t:C:1", "sweep:1", "sweep:2"])
			expect(x.store().wakes.isDelivered(id)).toBe(true);
	});

	test("composeWake: sweeps carry no thread, so none is ever folded; one item goes as itself", () => {
		const at = 1_000_000;
		const two = composeWake(
			[
				{ deliveryId: "answer:item:Q-aaaa", message: "one", queuedAt: at },
				{ deliveryId: "answer:item:Q-bbbb", message: "two", queuedAt: at + 1 },
			],
			at + MIN,
		);
		expect(two.folded).toBe(0);
		expect(two.message).toContain("item 2 of 2");
		expect(two.members).toEqual(["answer:item:Q-aaaa", "answer:item:Q-bbbb"]);
		expect(composeWake([{ deliveryId: "x", message: "solo", queuedAt: at }], at)).toEqual({
			deliveryId: "x",
			message: "solo",
			members: ["x"],
			kept: ["x"],
			folded: 0,
		});
	});
});

describe("the 20-minute ceiling", () => {
	test("a Steward busy past the ceiling gets the digest anyway, and no more than one per ceiling", async () => {
		const x = world();
		const relay = x.relay();
		x.w.gate = "busy";
		// The heartbeat's audit each minute keeps the busy stretch measured.
		x.deliver("first", "k1", TE("A"));
		relay.audit();
		for (let m = 1; m < 20; m++) {
			x.advance(MIN);
			relay.audit();
			await relay.pass();
		}
		expect(x.w.accepted).toHaveLength(0);
		x.advance(MIN);
		x.deliver("second", "k2", TE("B"));
		await relay.pass();
		expect(x.w.accepted).toHaveLength(1);
		expect(x.w.accepted[0]!.message).toContain("deliveryId: k1");
		expect(x.w.accepted[0]!.message).toContain("deliveryId: k2");
		expect(x.held()).toEqual([]);
		x.deliver("third", "k3", TE("C"));
		for (let m = 1; m < 20; m++) {
			x.advance(MIN);
			relay.audit();
			await relay.pass();
		}
		expect(x.w.accepted).toHaveLength(1);
		expect(x.held()).toEqual(["k3"]);
		x.advance(MIN);
		await relay.pass();
		expect(x.w.accepted.map((a) => a.deliveryId)).toEqual([x.w.accepted[0]!.deliveryId, "k3"]);
	});

	test("busy time is measured across looks, an idle look breaks it, and a stretch nobody watched is not busy time", () => {
		const st = {};
		const t0 = 10_000_000;
		for (let m = 0; m < 20; m++) expect(observe(st, "busy", t0 + m * MIN)).toEqual({ post: false, forced: false });
		expect(observe(st, "busy", t0 + 20 * MIN)).toEqual({ post: true, forced: true });
		const gap = { busySince: t0, seenAt: t0 + 3 * MIN } as { busySince?: number; seenAt?: number };
		expect(observe(gap, "idle", t0 + 4 * MIN)).toEqual({ post: true, forced: false });
		expect(gap.busySince).toBeUndefined();
		expect(observe({ busySince: t0, seenAt: t0 }, "busy", t0 + HOLD_CEILING_MS + MIN)).toEqual({
			post: false,
			forced: false,
		});
	});
});

describe("no double send across a crash", () => {
	test("the delivered commit is one statement over the row and every member: a restart from that moment sends nothing", async () => {
		const x = world();
		let crash: string | undefined;
		x.w.gate = "busy";
		x.deliver("a", "k1", TE("A"));
		x.deliver("b", "k2", TE("B"));
		x.w.gate = "idle";
		await x
			.relay({
				onDelivered: () => {
					crash ??= x.snap();
				},
			})
			.pass();
		expect(x.w.accepted).toHaveLength(1);
		x.restore(crash!);
		for (const id of ["k1", "k2", x.w.accepted[0]!.deliveryId]) expect(x.store().wakes.isDelivered(id)).toBe(true);
		x.advance(2 * MIN);
		expect(await x.relay().pass()).toEqual([]);
		expect(x.deliver("a", "k1", TE("A"))).toBe("known");
		expect(x.w.accepted).toHaveLength(1);
	});

	test("accepted by the webhook, not yet delivered: the documented window (one crash, two POSTs, same id and text); every item's id is in both", async () => {
		const x = world();
		x.deliver("a", "k1", TE("A"));
		x.deliver("b", "k2", TE("B"));
		let crash: string | undefined;
		x.w.onPost = () => {
			crash ??= x.snap();
		};
		await x.relay().pass();
		expect(x.w.accepted).toHaveLength(1);
		x.restore(crash!);
		expect(x.store().wakes.find("k1")).toMatchObject({ status: "pending", attempts: 1 });
		expect(await x.relay().pass()).toEqual(["k1", "k2"]);
		expect(x.w.accepted).toHaveLength(2);
		expect(x.w.accepted[1]).toEqual(x.w.accepted[0]!);
		for (const a of x.w.accepted) {
			expect(a.message).toContain("deliveryId: k1");
			expect(a.message).toContain("deliveryId: k2");
		}
		expect(x.store().wakes.find("k1")!.attempts).toBe(2);
		expect(await x.relay().pass()).toEqual([]);
	});
});

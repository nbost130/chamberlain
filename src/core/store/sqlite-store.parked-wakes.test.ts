/** Parked wakes (migration 21): a question card held for the principal lives in `held_wakes`, apart from the wakes the relay composes. */
import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import { runWakesCli } from "../delivery/wakes-cli.ts";
import type { HeldItem } from "./store-wakes.ts";

const parked = (id: string, releaseAt: number): HeldItem => ({
	deliveryId: id,
	message: `[chamberlain] needs_input: thread "T"\nthreadId: t1`,
	queuedAt: 1000,
	kind: "needs_input",
	thread: "t1",
	rights: [{ hash: "h1", at: "2026-11-18T12:00:00.000Z" }],
	parked: { releaseAt, lastWriteAt: 900, server: "mithrandir", requestIds: ["r1", "r2"] },
});
const news = (id: string): HeldItem => ({
	deliveryId: id,
	message: "note",
	queuedAt: 1100,
	kind: "note",
	thread: "t2",
});

describe("parked wakes", () => {
	test("held() leaves a parked card out and parked() lists only parked ones, record intact", () => {
		const s = memStore();
		expect(s.wakes.hold(parked("p1", 5000))).toBe(true);
		expect(s.wakes.hold(news("n1"))).toBe(true);
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["n1"]);
		expect(s.wakes.held(null).map((h) => h.deliveryId)).toEqual(["n1"]);
		const p = s.wakes.parked();
		expect(p.map((h) => h.deliveryId)).toEqual(["p1"]);
		expect(p[0]!.parked).toEqual({ releaseAt: 5000, lastWriteAt: 900, server: "mithrandir", requestIds: ["r1", "r2"] });
		expect(p[0]!.rights).toEqual([{ hash: "h1", at: "2026-11-18T12:00:00.000Z" }]);
	});

	test("the relay's composition never takes a parked card", () => {
		const s = memStore();
		s.wakes.hold(parked("p1", 5000));
		s.wakes.hold(news("n1"));
		const row = s.wakes.compose(2000, (held) => {
			expect(held.map((h) => h.deliveryId)).toEqual(["n1"]);
			return { deliveryId: "n1", message: "note", folded: 0, members: ["n1"] };
		});
		expect(row?.members.map((m) => m.deliveryId)).toEqual(["n1"]);
		expect(s.wakes.parked()).toHaveLength(1);
	});

	test("a parked id is known: it cannot be queued a second time", () => {
		const s = memStore();
		s.wakes.hold(parked("p1", 5000));
		expect(s.wakes.known("p1")).toBe(true);
		expect(s.wakes.enqueue({ deliveryId: "p1", message: "again", queuedAt: 1 })).toBe(false);
		expect(s.wakes.hold(parked("p1", 5000))).toBe(false);
	});

	test("unpark makes one pending row under the same id, with the new text and the stamp, in one step", () => {
		const s = memStore();
		s.wakes.hold(parked("p1", 5000));
		const row = s.wakes.unpark("p1", 6000, "new text");
		expect(row).toMatchObject({
			deliveryId: "p1",
			message: "new text",
			kind: "needs_input",
			thread: "t1",
			status: "pending",
			createdAt: 6000,
		});
		expect(row?.rights).toEqual([{ hash: "h1", at: "2026-11-18T12:00:00.000Z" }]);
		expect(row?.members.map((m) => m.deliveryId)).toEqual(["p1"]);
		expect(s.wakes.parked()).toEqual([]);
		expect(s.wakes.rows().map((r) => r.deliveryId)).toEqual(["p1"]);
		expect(s.wakes.unpark("p1", 7000, "twice")).toBeUndefined();
	});

	test("dropParked removes a parked card and nothing else", () => {
		const s = memStore();
		s.wakes.hold(parked("p1", 5000));
		s.wakes.hold(news("n1"));
		expect(s.wakes.dropParked("n1")).toBe(false);
		expect(s.wakes.dropParked("p1")).toBe(true);
		expect(s.wakes.dropParked("p1")).toBe(false);
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["n1"]);
		expect(s.wakes.rows("all")).toEqual([]);
	});
});

describe("the wakes list", () => {
	test("shows a parked card and when it is released, and says nothing when none is parked", () => {
		const s = memStore();
		const lines = () => {
			const out: string[] = [];
			runWakesCli(s, ["list"], (l) => out.push(l), {});
			return out;
		};
		expect(lines().some((l) => l.startsWith("parked"))).toBe(false);
		s.wakes.hold(parked("p1", Date.parse("2026-11-18T22:05:00.000Z")));
		const out = lines();
		expect(out.some((l) => l.startsWith("parked for the principal to answer") && l.endsWith(": 1"))).toBe(true);
		expect(out).toContain("  p1  until 2026-11-18T22:05:00.000Z");
	});
});

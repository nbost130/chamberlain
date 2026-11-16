/** F: dispatch, SLA and recovery (15). */
import { describe, expect, test } from "bun:test";
import { fileStore, min, T0, triageRig } from "../../testing/alert-triage-fixtures.ts";
import { maintain } from "../ops/maintain.ts";
import { runTriage } from "./alert-triage-cli.ts";
import { ALERT_TRIAGE } from "./alert-triage-config.ts";
import { alertKey } from "./alert-triage-ids.ts";
import { asOb, obKey, seqKey, slotCount } from "./alert-triage-obligation.ts";

describe("F dispatch SLA recovery", () => {
	test("F1 never held", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ family: "f1" });
		r.pass(min(1));
		expect(r.stewardRows().some((row) => row.status === "pending")).toBe(true);
		expect(r.store.wakes.held().filter((h) => h.deliveryId.startsWith("triage:"))).toHaveLength(0);
	});

	test("F2 batch + remainder", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], batchPerTick: 3, maxInFlight: 10 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		for (let i = 0; i < 7; i++) r.append({ family: `b${i}`, at: min(i + 1) });
		r.pass(min(7));
		expect(r.stewardRows()).toHaveLength(3);
		r.pass(min(8));
		expect(r.stewardRows()).toHaveLength(6);
		r.pass(min(9));
		expect(r.stewardRows()).toHaveLength(7);
		expect(r.stewardRows()[0]!.message).toMatch(/\d+ more alert tasks waiting/);
	});

	test("F3 in-flight cap", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], batchPerTick: 10, maxInFlight: 3 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		for (let i = 0; i < 5; i++) r.append({ family: `cap${i}`, at: min(i + 1) });
		r.pass(min(5));
		expect(slotCount(r.store)).toBe(3);
		expect(r.stewardRows()).toHaveLength(3);
		const occ = r.obligations().find((o) => o.state === "sent")!.occ;
		runTriage(r.store, ["ack", occ]);
		r.pass(min(6));
		expect(r.stewardRows()).toHaveLength(4);
	});

	test("F4 mixed tick preserves dueAt order", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], batchPerTick: 1, maxInFlight: 5, ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "A", at: min(1) });
		r.pass(min(1));
		r.append({ family: "B", at: min(2) });
		r.pass(min(2));
		const obA = r.obligations().find((o) => o.event.family === "A")!;
		const obB = r.obligations().find((o) => o.event.family === "B")!;
		const rowA = r.store.wakes.find(obA.attempts.at(-1)!)!;
		const rowB = r.store.wakes.find(obB.attempts.at(-1)!)!;
		// B finished earlier → due sooner (min 2+15) than A (min 5+15)
		r.store.wakes.finish(rowB.id, "delivered", min(2));
		r.store.wakes.finish(rowA.id, "delivered", min(5));
		const n = r.stewardRows().length;
		r.pass(min(30));
		expect(r.stewardRows().length).toBe(n + 1);
		const againB = r.obligations().find((o) => o.event.family === "B")!;
		expect(againB.ordinal).toBe(obB.ordinal + 1);
		expect(againB.readyAt).toBe(min(2) + 15 * 60_000);
		expect(againB.readyAt).toBeLessThan(min(30));
		const againA = r.obligations().find((o) => o.event.family === "A")!;
		expect(againA.state).toBe("queued"); // redispatched but waiting on batchPerTick
		expect(againA.readyAt).toBe(min(5) + 15 * 60_000);
	});

	test("F5 ack clock from delivery", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "f5" });
		r.pass(T0);
		const row = r.stewardRows()[0]!;
		r.store.wakes.finish(row.id, "delivered", min(10));
		const n = r.stewardRows().length;
		r.pass(min(15));
		expect(r.stewardRows()).toHaveLength(n);
		r.pass(min(25));
		expect(r.stewardRows().length).toBe(n + 1);
	});

	test("F6 ladder", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "lad" });
		r.pass(T0);
		const intervals = [15, 30, 60, 120, 240];
		let t = 0;
		for (const iv of intervals) {
			const row = r.stewardRows().at(-1)!;
			r.store.wakes.finish(row.id, "delivered", min(t));
			t += iv;
			r.pass(min(t));
			expect(r.obligations()[0]!.ordinal).toBeGreaterThan(0);
		}
	});

	test("F7 ack", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ family: "ackme" });
		r.pass(min(1));
		const occ = r.obligations()[0]!.occ;
		expect(runTriage(r.store, ["ack", occ])).toBe(0);
		expect(runTriage(r.store, ["ack", occ])).toBe(0);
		const n = r.stewardRows().length;
		r.pass(min(30));
		expect(r.stewardRows()).toHaveLength(n);
	});

	test("F8 resolve, prune, reopen, refire", () => {
		const db = fileStore();
		const store = db.open();
		const r = triageRig({ store, desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ source: "disk-guard", family: "swap-full" });
		r.pass(min(1));
		const ak = alertKey("disk-guard", "swap-full");
		expect(r.store.items.get(ALERT_TRIAGE, seqKey(ak))?.kind).toBe("seq");
		expect(r.store.items.get(ALERT_TRIAGE, obKey(ak))?.kind).toBe("obligation");
		const occ1 = r.obligations()[0]!.occ;
		const attempt1 = r.obligations()[0]!.attempts[0];
		runTriage(r.store, ["resolve", occ1]);
		expect(maintain(r.store, T0 + 31 * 24 * 3600_000).items).toBe(1);
		expect(r.store.items.get(ALERT_TRIAGE, obKey(ak))).toBeUndefined();
		expect(r.store.items.get(ALERT_TRIAGE, seqKey(ak))).toBeTruthy();
		store.close();
		const store2 = db.open();
		const r2 = triageRig({ store: store2, desk: { morningHour: 23, startAt: "beginning" } });
		r2.append({ source: "disk-guard", family: "swap-full", at: min(2) });
		r2.pass(min(2));
		expect(Number(asOb(r2.store.items.get(ALERT_TRIAGE, seqKey(ak))!.payload).seq)).toBe(2);
		const ob2 = r2.obligations()[0]!;
		expect(ob2.occ).not.toBe(occ1);
		expect(ob2.attempts[0]).not.toBe(attempt1);
		expect(
			r2.stewardRows().filter((row) => row.deliveryId === ob2.attempts[0] && row.status === "pending"),
		).toHaveLength(1);
		store2.close();
	});

	test("F9 repeat must take a slot again", () => {
		const db = fileStore();
		const store = db.open();
		const r = triageRig({
			store,
			triage: { enabled: true, rules: [], maxInFlight: 1, batchPerTick: 5 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "A" });
		r.pass(min(1));
		const aKey = r.store.items
			.list({ source: ALERT_TRIAGE, kind: "obligation" })
			.find((i) => asOb(i.payload).event.family === "A")!.dedupKey;
		runTriage(r.store, ["ack", r.obligations()[0]!.occ]);
		r.store.items.patch(ALERT_TRIAGE, aKey, { ackedAt: min(1) });
		r.append({ family: "B", at: min(2) });
		r.pass(min(2));
		expect(slotCount(r.store)).toBe(1);
		const tFire = min(2) + 25 * 3600_000;
		r.append({ family: "A", at: tFire });
		r.pass(tFire);
		const a = r.obligations().find((o) => o.event.family === "A")!;
		expect(a.state).toBe("queued");
		expect(a.slot).toBe(false);
		expect(a.reason).toBe("repeat");
		expect(a.attempts).toHaveLength(1);
		store.close();
		const store2 = db.open();
		const r2 = triageRig({
			store: store2,
			triage: { enabled: true, rules: [], maxInFlight: 1 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r2.pass(tFire + 1000);
		expect(r2.obligations().find((o) => o.event.family === "A")!.attempts).toHaveLength(1);
		runTriage(store2, ["ack", r2.obligations().find((o) => o.event.family === "B")!.occ]);
		r2.pass(tFire + 2000);
		const a2 = r2.obligations().find((o) => o.event.family === "A")!;
		expect(a2.attempts).toHaveLength(2);
		expect(a2.slot).toBe(true);
		expect(slotCount(store2)).toBeLessThanOrEqual(1);
		store2.close();
	});

	test("F10 dead letter / cancel", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "dead" });
		r.pass(T0);
		const row = r.stewardRows()[0]!;
		r.store.wakes.finish(row.id, "dead_letter", T0);
		const n = r.stewardRows().length;
		r.pass(min(15));
		expect(r.stewardRows().length).toBe(n + 1);
		expect(r.obligations()[0]!.attempts.length).toBeGreaterThan(1);
	});

	test("F11 no callback dependency", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "nocb" });
		r.pass(T0);
		r.store.wakes.finish(r.stewardRows()[0]!.id, "delivered", min(10));
		r.pass(min(25));
		expect(r.stewardRows().length).toBe(2);
	});

	test("F12 restart mid-SLA", () => {
		const db = fileStore();
		const store = db.open();
		const r = triageRig({
			store,
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "mid" });
		r.pass(T0);
		r.store.wakes.finish(r.stewardRows()[0]!.id, "delivered", T0);
		const before = r.stewardRows().length;
		store.close();
		const store2 = db.open();
		const r2 = triageRig({
			store: store2,
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		expect(r2.stewardRows()).toHaveLength(before);
		r2.pass(min(15));
		expect(r2.stewardRows()).toHaveLength(before + 1);
		r2.pass(min(16));
		expect(r2.stewardRows()).toHaveLength(before + 1);
		store2.close();
	});
});

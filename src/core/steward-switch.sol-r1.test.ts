/**
 * Sol FAIL #63 fix-round 1: B1–B3, M1–M3 probes adopted as product tests.
 * Each guarantee fails when its enforcing line is removed (see mutation table in build report).
 */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../testing/lock.ts";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { createRelay } from "./relay.ts";
import { commitSwitch } from "./steward-commit.ts";
import { countingReceipt, isDischarged } from "./steward-discharge.ts";
import { checkSwitchNotice } from "./steward-notice.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { composeTransferBatch, transferPass } from "./steward-transfer.ts";
import { encodedSendBytes, SWITCH_NOTICE_STALL_MS, TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";

const { confWorld, memStoreSeeded, writeSwitchRefs, deliverAndLedger, fakeClock } = useStewardSwitchFixtures();

function switchToG2(store: ReturnType<typeof memStoreSeeded>, conf: string, now = Date.now()) {
	const p = prepareSwitch(store, conf, { toThread: "g2", live: true, now });
	if (!p.ok) throw new Error(p.error);
	writeSwitchRefs(conf, p.id);
	expect(commitSwitch(store, conf, { id: p.id, live: true, now }).ok).toBe(true);
}

describe("B2/B3: counting-receipt predicate (discharge, transfer, retention)", () => {
	test("B2: late retired own receipt must not permit pruning", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1, gen: 1 });
		switchToG2(s, w.conf);
		s.steward.insertReceipt({ outboxId: id, kind: "t3-run", runId: "late", thread: "old", recordedAt: 3 });
		expect(countingReceipt(s, id)).toBe(false);
		expect(isDischarged(s, id)).toBe(false);
		s.wakes.prune(100);
		expect(s.wakes.find("R")).toBeDefined();
	});

	test("B3: retired descendant receipt must not discharge ancestor", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "p", at: 1, gen: 1 });
		switchToG2(s, w.conf);
		transferPass(s);
		const item = s.steward.transferItemForOrig(1, id)!;
		s.wakes.compose(2, (held) => composeTransferBatch(held, 2)!);
		const row = s.wakes.find(item.itemId)!;
		s.wakes.finish(row.id, "delivered", 2);
		s.steward.insertLedger({ outboxId: row.id, gen: 2, origin: "live" });
		switchToG2(s, w.conf); // g3 — retires g2
		s.steward.insertReceipt({ outboxId: row.id, kind: "t3-run", runId: "late", thread: "g2", recordedAt: 4 });
		expect(countingReceipt(s, row.id)).toBe(false);
		expect(isDischarged(s, id)).toBe(false);
	});

	test("B3b: three-generation — current descendant receipt discharges; late retired does not", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = deliverAndLedger(s, { deliveryId: "R3", message: "p", at: 1, gen: 1 });
		switchToG2(s, w.conf);
		transferPass(s);
		const item = s.steward.transferItemForOrig(1, id)!;
		s.wakes.compose(2, (held) => composeTransferBatch(held, 2)!);
		const mid = s.wakes.find(item.itemId)!;
		s.wakes.finish(mid.id, "delivered", 2);
		s.steward.insertLedger({ outboxId: mid.id, gen: 2, origin: "live" });
		// Current-gen receipt on mid before g3: discharges.
		s.steward.insertReceipt({ outboxId: mid.id, kind: "t3-run", runId: "ok", thread: "g2", recordedAt: 3 });
		expect(isDischarged(s, id)).toBe(true);
	});
});

describe("R1: one Steward identity for rights decision and prerequisite hash", () => {
	test("stale mirror: g2 snapshot stamp hash matches g2 rights decision", async () => {
		const { CoreRights } = await import("./engine-core-rights.ts");
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const fake: Record<string, unknown> = {
			store: s,
			privateFile: () => "g1",
			rightsRules: () => "rules",
			stewardSession: async () => undefined,
			rightsSent: { get: () => undefined, epoch: () => 0 },
			probe: () => undefined,
		};
		fake.wakeRights = CoreRights.prototype.wakeRights.bind(fake);
		const now = await (
			CoreRights.prototype as unknown as {
				rightsNow: (o?: { steward?: string }) => Promise<{
					hash?: string;
					wake: (id: string) => { stamp?: { hash: string } };
				}>;
			}
		).rightsNow.call(fake, { steward: "g2" });
		expect(now.wake("R").stamp?.hash).toBe(now.hash);
	});
});

describe("B1: one-generation snapshot for rights, CAS and transport", () => {
	test("rights check crossing commit must not POST pointer without rechecking g2 rights", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const hash = "a".repeat(64);
		s.state.set("rights-sent", { hash, steward: w.stewardThread, epoch: 0 });
		s.wakes.enqueue({
			deliveryId: "pointer",
			message: "rights unchanged",
			queuedAt: 1,
			rights: [{ hash, steward: w.stewardThread }],
		});
		const posts: string[] = [];
		const targets: (string | undefined)[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			conf: w.conf,
			rightsNow: async () => {
				switchToG2(s, w.conf);
				return { hash, steward: w.stewardThread, wake: () => ({ message: "full rights" }) };
			},
			wake: {
				ready: () => true,
				send: async (id, _m, opts) => {
					posts.push(id);
					targets.push(opts?.target);
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		expect(posts).not.toContain("pointer");
		expect(s.wakes.find("pointer")?.attempts ?? 0).toBe(0);
		expect(s.steward.maxGen()).toBe(2);
	});

	test("after commit settles, POST uses snapshotted g2 wake URL and attempt_gen", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		const prep = prepareSwitch(s, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		const { wakeUrl } = writeSwitchRefs(w.conf, prep.id, { wakeUrl: "https://fake.example/hooks/g2-only" });
		expect(commitSwitch(s, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		s.wakes.enqueue({ deliveryId: "plain", message: "no rights stamp", queuedAt: clock.t });
		const posts: { id: string; target?: string }[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			conf: w.conf,
			now: () => clock.t,
			wake: {
				ready: () => true,
				send: async (id, _m, opts) => {
					posts.push({ id, target: opts?.target });
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		const hit = posts.find((p) => p.id === "plain");
		expect(hit).toBeDefined();
		expect(hit!.target).toBe(wakeUrl);
		expect(s.wakes.find("plain")!.attemptGen).toBe(2);
	});
});

describe("M1/R2: encoded byte cap — oversized solo refused, never sent", () => {
	test("single large multibyte transfer is refused (no batch, under-bound guarantee)", () => {
		const big = "界".repeat(10_000);
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
		const b = composeTransferBatch([{ deliveryId: "x", message: big, kind: "transfer", queuedAt: 1 }], 1);
		expect(b).toBeUndefined();
	});

	test("second item does not join when batch would exceed encoded cap", () => {
		const chunk = "界".repeat(4_000); // 12000 bytes each
		const b = composeTransferBatch(
			[
				{ deliveryId: "a", message: chunk, kind: "transfer", queuedAt: 1 },
				{ deliveryId: "b", message: chunk, kind: "transfer", queuedAt: 2 },
			],
			1,
		)!;
		expect(b.members).toEqual(["a"]);
		expect(encodedSendBytes(b.message, b.deliveryId)).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);
	});

	test("oversized transfer is dead-lettered with alarm on compose, never POSTed", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const big = "界".repeat(10_000);
		s.wakes.hold({ deliveryId: "transfer:over:g1", message: big, queuedAt: 1, kind: "transfer" });
		const posts: string[] = [];
		const alarms: string[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: (k) => alarms.push(k),
			wake: {
				ready: () => true,
				send: async (id) => {
					posts.push(id);
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		expect(posts).not.toContain("transfer:over:g1");
		expect(s.wakes.find("transfer:over:g1")?.status).toBe("dead_letter");
		expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(true);
	});

	test("mixed ordinary held wakes do not expand a transfer digest", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = deliverAndLedger(s, { deliveryId: "R-mix", message: "orig", at: 1, gen: 1 });
		switchToG2(s, w.conf);
		transferPass(s);
		s.wakes.hold({ deliveryId: "sweep:1", message: "ordinary ".repeat(500), queuedAt: 2, kind: "sweep" });
		const held = s.wakes.held();
		const transfers = held.filter((h) => h.kind === "transfer");
		const batch = composeTransferBatch(transfers, 3)!;
		expect(batch.members.every((m) => m.startsWith("transfer:"))).toBe(true);
		expect(encodedSendBytes(batch.message, batch.deliveryId)).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);
		expect(held.some((h) => h.deliveryId === "sweep:1")).toBe(true);
		expect(s.steward.transferItemForOrig(1, id)).toBeDefined();
	});
});

describe("M2: steward-switch-unacknowledged alarm (G1/G2)", () => {
	test("G1: delivered notice without receipt past stall raises alarm; receipt clears", () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		switchToG2(s, w.conf, clock.t);
		const t = s.steward.transfer(1)!;
		const notice = s.wakes.find(t.noticeId)!;
		s.wakes.finish(notice.id, "delivered", clock.t);
		s.steward.insertLedger({ outboxId: notice.id, gen: 2, origin: "live" });
		const alarms: string[] = [];
		expect(checkSwitchNotice(s, (k) => alarms.push(k), clock.t + 1000, SWITCH_NOTICE_STALL_MS)).toBe(false);
		expect(alarms).toEqual([]);
		expect(
			checkSwitchNotice(s, (k) => alarms.push(k), clock.t + SWITCH_NOTICE_STALL_MS + 1, SWITCH_NOTICE_STALL_MS),
		).toBe(true);
		expect(alarms).toEqual(["steward-switch-unacknowledged"]);
		s.steward.insertReceipt({ outboxId: notice.id, kind: "operator", recordedAt: clock.t });
		alarms.length = 0;
		expect(
			checkSwitchNotice(s, (k) => alarms.push(k), clock.t + SWITCH_NOTICE_STALL_MS * 2, SWITCH_NOTICE_STALL_MS),
		).toBe(false);
		expect(alarms).toEqual([]);
	});

	test("G2: retired notice is not an obligation after another switch", () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		switchToG2(s, w.conf, clock.t);
		const t1 = s.steward.transfer(1)!;
		s.wakes.finish(s.wakes.find(t1.noticeId)!.id, "delivered", clock.t);
		switchToG2(s, w.conf, clock.t + 1); // g3 — current notice is g2→g3
		const alarms: string[] = [];
		// Before the current notice's stall elapses: retired g1 notice must not alarm.
		checkSwitchNotice(s, (k) => alarms.push(k), clock.t + 1 + SWITCH_NOTICE_STALL_MS - 1, SWITCH_NOTICE_STALL_MS);
		expect(alarms).toEqual([]);
	});

	test("G2/R3: pending current notice past stall raises switch alarm", () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		switchToG2(s, w.conf, clock.t);
		const alarms: string[] = [];
		expect(
			checkSwitchNotice(s, (k) => alarms.push(k), clock.t + SWITCH_NOTICE_STALL_MS + 1, SWITCH_NOTICE_STALL_MS),
		).toBe(true);
		expect(alarms).toEqual(["steward-switch-unacknowledged"]);
	});

	test("G2/R3: dead-letter current notice past stall raises switch alarm", () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		switchToG2(s, w.conf, clock.t);
		const notice = s.wakes.find(s.steward.transfer(1)!.noticeId)!;
		s.wakes.finish(notice.id, "dead_letter", clock.t + 2);
		const alarms: string[] = [];
		expect(
			checkSwitchNotice(s, (k) => alarms.push(k), clock.t + SWITCH_NOTICE_STALL_MS + 10, SWITCH_NOTICE_STALL_MS),
		).toBe(true);
		expect(alarms).toEqual(["steward-switch-unacknowledged"]);
	});
});

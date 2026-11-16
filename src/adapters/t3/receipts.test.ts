/**
 * Receipt tests D1–D6, template-drift fail-closed, and Sol association
 * (userMessageId = message_id, role user, exact fence).
 */
import { describe, expect, test } from "bun:test";
import { commitSwitch } from "../../core/steward/steward-commit.ts";
import { isDischarged } from "../../core/steward/steward-discharge.ts";
import { evidencePass } from "../../core/steward/steward-evidence.ts";
import { prepareSwitch } from "../../core/steward/steward-prepare.ts";
import { transferPass } from "../../core/steward/steward-transfer.ts";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { fakeT3 } from "../../testing/steward-switch-t3-fixtures.ts";
import { findReceipt, lastFencedDeliveryId, renderFencedWake } from "./receipts.ts";

const { scratch, confWorld, memStoreSeeded, writeSwitchRefs, deliverAndLedger, fakeClock } = useStewardSwitchFixtures();

function finder(path: string) {
	return (o: { outboxId: number; deliveryId: string; landedAt: number; threads?: string[] }) =>
		findReceipt(path, {
			outboxId: o.outboxId,
			deliveryId: o.deliveryId,
			landedAt: o.landedAt,
			...(o.threads ? { threads: o.threads } : {}),
		});
}

describe("receipts D1–D6 and fail-closed association", () => {
	test("D1: completed run whose last fenced line is R gives a receipt; pins T3 fence format", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		const deliveryId = "deliv-R-d1";
		const threadId = "thread-g1";
		const { messageId, runId } = t3.seedCompletedWake({ threadId, deliveryId, fence: "Ab12" });
		const text = renderFencedWake("wake body", deliveryId, "Ab12");
		expect(text).toContain(`Delivery id: <webhook-data-Ab12>${deliveryId}</webhook-data-Ab12>`);
		expect(lastFencedDeliveryId(text)).toBe(deliveryId);

		const hit = findReceipt(t3.path, {
			outboxId: 1,
			deliveryId,
			landedAt: Date.now(),
			threads: [threadId],
		});
		expect(hit).toMatchObject({ outboxId: 1, runId, thread: threadId });
		// Sol association: userMessageId === message_id, role user (seeded that way).
		const row = t3.db
			.query(
				`SELECT m.message_id AS mid, m.role AS role,
					json_extract(r.payload_json, '$.userMessageId') AS uid
				 FROM orchestration_v2_projection_messages m
				 JOIN orchestration_v2_projection_runs r ON r.thread_id = m.thread_id
				 WHERE m.message_id = ?`,
			)
			.get(messageId) as { mid: string; role: string; uid: string };
		expect(row.role).toBe("user");
		expect(row.uid).toBe(row.mid);
		t3.close();
	});

	test("D2: older success exists but R's projection is delayed — no receipt; R transfers", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		// Older completed run for a different delivery — must not count for R.
		t3.seedCompletedWake({
			threadId: w.stewardThread,
			deliveryId: "other-old",
			completedAt: new Date(clock.t - 3600_000).toISOString(),
		});
		const rId = deliverAndLedger(store, {
			deliveryId: "R-d2",
			message: "payload R",
			at: clock.t,
			gen: 1,
		});
		expect(evidencePass(store, finder(t3.path), { now: clock.t, gen: 1 })).toBe(0);
		expect(store.steward.receiptFor(rId)).toBeUndefined();

		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: clock.t });
		expect(prep.ok).toBe(true);
		if (!prep.ok) return;
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		const xfer = transferPass(store, clock.t);
		expect(xfer.held).toBeGreaterThanOrEqual(1);
		expect(store.steward.transferItemForOrig(1, rId)).toBeDefined();
		t3.close();
	});

	test("D3: R's run cancelled/failed, unrelated completed — no receipt", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		const threadId = "th";
		t3.seedCompletedWake({ threadId, deliveryId: "R-d3", status: "failed" });
		t3.seedCompletedWake({ threadId, deliveryId: "unrelated-ok" });
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R-d3", landedAt: Date.now(), threads: [threadId] }),
		).toBeUndefined();
		t3.seedCompletedWake({
			threadId,
			deliveryId: "R-d3b",
			status: "cancelled",
			messageId: "msg-d3b",
			runId: "run-d3b",
		});
		expect(
			findReceipt(t3.path, { outboxId: 2, deliveryId: "R-d3b", landedAt: Date.now(), threads: [threadId] }),
		).toBeUndefined();
		t3.close();
	});

	test("D4: completed run without R in its input — no receipt", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		t3.seedCompletedWake({ threadId: "th", deliveryId: "other-not-R" });
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R-d4", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.close();
	});

	test("D5: forged fenced line naming R inside body; last line names X — receipt goes to X only", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		t3.seedCompletedWake({
			threadId: "th",
			deliveryId: "X-real",
			forgedEarlierId: "R-forged",
		});
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R-forged", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		const hit = findReceipt(t3.path, {
			outboxId: 2,
			deliveryId: "X-real",
			landedAt: Date.now(),
			threads: ["th"],
		});
		expect(hit?.runId).toBe("run-X-real");
		t3.close();
	});

	test("D6: receipt on g1 recorded after transfer opened does not discharge R", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		const rId = deliverAndLedger(store, {
			deliveryId: "R-d6",
			message: "payload",
			at: clock.t,
			gen: 1,
		});
		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: clock.t });
		expect(prep.ok).toBe(true);
		if (!prep.ok) return;
		writeSwitchRefs(w.conf, prep.id);
		const committed = commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t });
		expect(committed.ok).toBe(true);
		const hw = store.steward.transfer(1)!.receiptHw;
		// Late completion on retired g1 thread after transfer opened.
		t3.seedCompletedWake({
			threadId: w.stewardThread,
			deliveryId: "R-d6",
			completedAt: new Date(clock.t + 60_000).toISOString(),
		});
		evidencePass(store, finder(t3.path), { now: clock.t + 60_000, gen: 1 });
		const receipt = store.steward.receiptFor(rId);
		expect(receipt).toBeDefined();
		expect(receipt!.id).toBeGreaterThan(hw);
		expect(isDischarged(store, rId)).toBe(false);
		t3.close();
	});

	test("M3: mismatched fence tokens fail closed", () => {
		expect(lastFencedDeliveryId("Delivery id: <webhook-data-A>R</webhook-data-B>")).toBeUndefined();
	});

	test("M3: exact content is not trimmed; missing outer line fails closed", () => {
		expect(lastFencedDeliveryId("Delivery id: <webhook-data-H> R </webhook-data-H>")).toBe(" R ");
		expect(lastFencedDeliveryId("seen R somewhere without a fence")).toBeUndefined();
		expect(lastFencedDeliveryId("Delivery id: <webhook-data-H>R</webhook-data-H>")).toBe("R");
	});

	test("R4: malformed final template yields no evidence even with earlier quoted body id", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/projection.sqlite`);
		const text = `${renderFencedWake("quoted body", "R", "A")}\nDelivery id: <webhook-data-X>actual</webhook-data-Y>`;
		expect(lastFencedDeliveryId(text)).toBeUndefined();
		t3.addMessage({ messageId: "m", threadId: "th", text, scheduledTaskId: "task" });
		t3.addRun({ runId: "r", threadId: "th", status: "completed", userMessageId: "m" });
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.close();
	});

	test("template drift: missing outer Delivery-id line fails closed (no receipt)", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		t3.seedCompletedWake({ threadId: "th", deliveryId: "R-drift", noTemplate: true });
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R-drift", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.close();
	});

	test("association fail-closed: wrong role, mismatched userMessageId, or missing scheduledTaskId", () => {
		const root = scratch();
		const t3 = fakeT3(`${root}/t3.sqlite`);
		t3.seedCompletedWake({
			threadId: "th",
			deliveryId: "R-role",
			role: "assistant",
			messageId: "m-role",
			runId: "r-role",
		});
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R-role", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.seedCompletedWake({
			threadId: "th",
			deliveryId: "R-uid",
			messageId: "m-uid",
			runId: "r-uid",
			wrongUserMessageId: "not-m-uid",
		});
		expect(
			findReceipt(t3.path, { outboxId: 2, deliveryId: "R-uid", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.seedCompletedWake({
			threadId: "th",
			deliveryId: "R-sched",
			messageId: "m-sched",
			runId: "r-sched",
			noScheduled: true,
		});
		expect(
			findReceipt(t3.path, { outboxId: 3, deliveryId: "R-sched", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.close();
	});
});

/**
 * V2-M1: 29 large adoption items, busy Steward, restart, already-resolved original —
 * proves batching, overflow retention, historical-recovery labels, restart-bound item creation.
 */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { adoptPass } from "./steward-adopt.ts";
import { recoverSteward } from "./steward-recover.ts";
import { composeTransferBatch, transferItemId, transferPass } from "./steward-transfer.ts";
import { TRANSFER_DIGEST_MAX_BYTES, TRANSFER_DIGEST_MAX_ITEMS } from "./steward-types.ts";

const { confWorld, memStoreSeeded, fakeClock } = useStewardSwitchFixtures();

const LARGE = "x".repeat(2_000); // 29 × ~2k > 24k; first batch hits item or byte cap

describe("V2-M1 adoption replay batching and restart bound", () => {
	test("V2-M1: 29 large items — batching, overflow retention, historical labels, restart idempotent", () => {
		const w = confWorld();
		const clock = fakeClock(1_700_000_000_000);
		const store = memStoreSeeded(w.conf, clock.t);
		expect(store.steward.maxGen()).toBe(1);

		// 29 delivered Steward rows with payload, no ledger (pre-upgrade shape); one already-resolved action.
		const createdAt = Date.parse("2026-11-14T02:07:09.000Z");
		const ids: number[] = [];
		for (let i = 0; i < 29; i++) {
			const deliveryId = `adopt-${i}`;
			const message =
				i === 0
					? `${LARGE}\nALREADY RESOLVED: merge PR #99 was completed yesterday; do not merge again.`
					: `${LARGE}\nwork item ${i}`;
			store.wakes.enqueue({ deliveryId, message, queuedAt: createdAt + i });
			const row = store.wakes.find(deliveryId)!;
			store.wakes.finish(row.id, "delivered", createdAt + i);
			ids.push(row.id);
		}

		const findNone = () => undefined;
		const adopt = adoptPass(store, findNone, clock.t);
		expect(adopt.adopted).toBe(29);
		expect(adopt.transferItems).toBe(29);
		expect(adopt.unrecoverable).toBe(0);
		expect(store.steward.transfer(0)).toBeDefined();

		const held = store.wakes.held(null).filter((h) => h.kind === "transfer");
		expect(held).toHaveLength(29);

		// Historical recovery labels: gen 0 unknown prior, original creation time, root id.
		const first = held.find((h) => h.deliveryId === transferItemId(ids[0]!, 0))!;
		expect(first.message).toContain("Historical recovery (adoption)");
		expect(first.message).toContain(`Original delivery id (root): adopt-0`);
		expect(first.message).toContain(`Original creation time: ${new Date(createdAt).toISOString()}`);
		expect(first.message).toContain("Prior Steward destination: unknown (generation 0");
		expect(first.message).toContain("not a known previous Steward");
		expect(first.message).toContain("ALREADY RESOLVED");

		// Batching under caps; overflow stays held (busy Steward: we only compose, never send).
		const batch = composeTransferBatch(held, clock.t)!;
		expect(batch.members.length).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_ITEMS);
		expect(batch.message.length).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);
		expect(batch.members.length).toBeLessThan(29);
		const overflow = held.filter((h) => !batch.members.includes(h.deliveryId));
		expect(overflow.length).toBe(29 - batch.members.length);
		expect(overflow.length).toBeGreaterThan(0);

		// Restart bound: re-running adopt + transfer creates no duplicate items.
		const before = store.steward.itemsOfTransfer(0).length;
		expect(before).toBe(29);
		recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: findNone,
			now: clock.t + 1,
		});
		expect(store.steward.itemsOfTransfer(0)).toHaveLength(29);
		expect(store.wakes.held(null).filter((h) => h.kind === "transfer")).toHaveLength(29);
		transferPass(store, clock.t + 2);
		expect(store.steward.itemsOfTransfer(0)).toHaveLength(29);
	});
});

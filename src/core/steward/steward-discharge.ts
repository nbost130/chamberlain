/**
 * Discharge: one counting-receipt predicate for transfer, retention and status.
 * Each envelope uses its own ledger generation's retirement cutoff (B2/B3).
 */

import type { Store } from "../store/store.ts";
import type { TransferItem } from "./steward-types.ts";

/**
 * True when `outboxId` has a receipt that still counts for its own ledger generation.
 * A receipt on generation F counts when F has no transfer yet, when `receipt.id ≤ transfer(F).receipt_hw` (recorded before the switch), or
 * when it is a T3 run receipt whose run completed at or before the transfer opened: that Steward handled the wake before it was retired,
 * however late the daemon found the proof. A run that completed after the switch (a retired Steward still working) never counts, so the
 * new Steward still gets the wake.
 * Unledgered rows never count as discharged via their own receipt (retention must not erase them).
 * The same predicate is COUNTING_RECEIPT_SQL in sqlite-wakes.ts (retention).
 */
export function countingReceipt(store: Store, outboxId: number): boolean {
	const r = store.steward.receiptFor(outboxId);
	if (!r) return false;
	const led = store.steward.ledger(outboxId);
	if (!led) return false;
	const t = store.steward.transfer(led.gen);
	return t === undefined || r.id <= t.receiptHw || (r.kind === "t3-run" && r.recordedAt <= t.openedAt);
}

/** Transfer items whose root or orig is this outbox id (open and closed transfers). */
function itemsForRoot(store: Store, rootOutboxId: number): TransferItem[] {
	const out: TransferItem[] = [];
	for (let g = 0; g <= store.steward.maxGen(); g++) {
		for (const item of store.steward.itemsOfTransfer(g)) {
			if (item.rootOutboxId === rootOutboxId || item.origOutboxId === rootOutboxId) out.push(item);
		}
	}
	return out;
}

/**
 * True when this root (or orig) is discharged: a counting receipt on itself, or on any
 * descendant transfer envelope whose own generation cutoff still admits its receipt.
 */
export function isDischarged(store: Store, rootOutboxId: number): boolean {
	if (countingReceipt(store, rootOutboxId)) return true;
	for (const item of itemsForRoot(store, rootOutboxId)) {
		const row = store.wakes.find(item.itemId);
		if (row && countingReceipt(store, row.id)) return true;
	}
	return false;
}

/** Operator release: writes an operator receipt for one outbox id. */
export function releaseWake(store: Store, deliveryId: string, now = Date.now()): boolean {
	const row = store.wakes.find(deliveryId);
	if (!row) return false;
	if (store.steward.receiptFor(row.id)) return true;
	store.tx(() => {
		store.steward.insertReceipt({ outboxId: row.id, kind: "operator", recordedAt: now });
	});
	return true;
}

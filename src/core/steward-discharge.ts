/**
 * Discharge: one counting-receipt predicate for transfer, retention and status.
 * Each envelope uses its own ledger generation's retirement cutoff (B2/B3).
 */

import type { TransferItem } from "./steward-types.ts";
import type { Store } from "./store.ts";

/**
 * True when `outboxId` has a receipt that still counts for its own ledger generation.
 * A receipt on generation F counts only when `receipt.id ≤ transfer(F).receipt_hw` (or F has no transfer yet).
 * Unledgered rows never count as discharged via their own receipt (retention must not erase them).
 */
export function countingReceipt(store: Store, outboxId: number): boolean {
	const r = store.steward.receiptFor(outboxId);
	if (!r) return false;
	const led = store.steward.ledger(outboxId);
	if (!led) return false;
	const t = store.steward.transfer(led.gen);
	return t === undefined || r.id <= t.receiptHw;
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

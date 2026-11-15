/**
 * Discharge: a receipt on a root or any descendant transfer item closes the obligation.
 * A receipt on generation F counts only when receipt.id ≤ transfer(F).receipt_hw (D6).
 */

import type { TransferItem } from "./steward-types.ts";
import type { Store } from "./store.ts";

/** True when outboxId itself has a counting receipt under optional high-water. */
function ownReceipt(store: Store, outboxId: number, hw?: number): boolean {
	const r = store.steward.receiptFor(outboxId);
	if (!r) return false;
	return hw === undefined || r.id <= hw;
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
 * outbox row that carries a transfer item descended from it (any generation in the chain).
 */
export function isDischarged(store: Store, rootOutboxId: number, hw?: number): boolean {
	// High-water gates only the root's own receipt (D6: late completions on a retired gen).
	// A receipt on any descendant transfer item discharges the chain (M1 / J2 / J3).
	if (ownReceipt(store, rootOutboxId, hw)) return true;
	for (const item of itemsForRoot(store, rootOutboxId)) {
		const row = store.wakes.find(item.itemId);
		if (row && ownReceipt(store, row.id)) return true;
	}
	return false;
}

/** Counting high-water for generation F's transfer, if one is open. */
export function receiptHwFor(store: Store, fromGen: number): number | undefined {
	const t = store.steward.transfer(fromGen);
	return t?.receiptHw;
}

/** Whether a ledgered delivery's receipt still counts for its generation. */
export function receiptCounts(store: Store, outboxId: number, gen: number): boolean {
	const hw = receiptHwFor(store, gen);
	return ownReceipt(store, outboxId, hw);
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

/**
 * Discharge: one counting-receipt predicate for transfer, retention and status.
 * Each envelope uses its own ledger generation's retirement cutoff (B2/B3).
 */

import type { Store } from "../store/store.ts";
import type { TransferItem } from "./steward-types.ts";

/**
 * True when `outboxId` has a receipt that still counts for its own ledger generation.
 * A receipt on generation F counts when F has no transfer yet, when `receipt.id ≤ transfer(F).receipt_hw` (recorded before the switch), or
 * when it is a T3 run receipt whose run completed at least RECEIPT_CLOCK_MARGIN_MS before the transfer opened: that Steward handled the
 * wake before it was retired, however late the daemon found the proof. The run's time is T3's and the opening is the daemon's, so the margin
 * absorbs clock disagreement between them. A run that completed after the switch (a retired Steward still working) never counts, so the new
 * Steward still gets the wake.
 * Unledgered rows never count as discharged via their own receipt (retention must not erase them).
 * The same predicate is COUNTING_RECEIPT_SQL in sqlite-wakes.ts (retention).
 */
export function countingReceipt(store: Store, outboxId: number): boolean {
	const r = store.steward.receiptFor(outboxId);
	if (!r) return false;
	const led = store.steward.ledger(outboxId);
	if (!led) return false;
	const t = store.steward.transfer(led.gen);
	return (
		t === undefined ||
		r.id <= t.receiptHw ||
		(r.kind === "t3-run" && r.recordedAt <= t.openedAt - RECEIPT_CLOCK_MARGIN_MS)
	);
}

/** How far before a switch a retired Steward's run must have completed for a late-found receipt to count (also in COUNTING_RECEIPT_SQL). */
const RECEIPT_CLOCK_MARGIN_MS = 60_000;

/** Transfer generations advance monotonically. A composed digest can itself be transferred in a later generation. */
function* descendantItems(store: Store, original: number): Generator<{ item: TransferItem; envelopeId?: number }> {
	const reached = new Set([original]);
	for (let g = 0; g <= store.steward.maxGen(); g++) {
		for (const item of store.steward.itemsOfTransfer(g)) {
			if (!reached.has(item.rootOutboxId) && !reached.has(item.origOutboxId)) continue;
			const envelope = store.wakes.find(item.itemId);
			if (envelope) reached.add(envelope.id);
			yield { item, envelopeId: envelope?.id };
		}
	}
}

/**
 * True when this root (or orig) is discharged: a counting receipt on itself, or on any descendant transfer envelope whose own generation
 * cutoff still admits its receipt. Also when the row is gone: retention deletes a Steward row only once it is discharged (or unrecoverable),
 * so a missing row was settled. And when the row is itself a transfer envelope (a replay delivered to an earlier successor) every one of whose
 * members replays a root that is discharged: the envelope carried nothing the Steward still needs.
 */
export function isDischarged(store: Store, rootOutboxId: number, depth = 0): boolean {
	const row = store.wakes.byId(rootOutboxId);
	if (!row) return true;
	if (countingReceipt(store, rootOutboxId)) return true;
	for (const { envelopeId } of descendantItems(store, rootOutboxId)) {
		if (envelopeId !== undefined && countingReceipt(store, envelopeId)) return true;
	}
	return depth < 3 && envelopeOfDischarged(store, row.members, depth);
}

/** Whether every member is a transfer item whose root is discharged (so the envelope that carried them needs no replay). */
function envelopeOfDischarged(store: Store, members: { deliveryId: string }[], depth: number): boolean {
	if (!members.length) return false;
	return members.every((m) => {
		const item = store.steward.transferItem(m.deliveryId);
		return item !== undefined && item.rootOutboxId !== undefined && isDischarged(store, item.rootOutboxId, depth + 1);
	});
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

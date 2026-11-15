/**
 * Adoption of pre-upgrade Steward delivered rows (B3): runs at every daemon start under the relay lock.
 * Empty payloads → unrecoverable. Payload without receipt → gen 0 standing transfer. Receipt found → gen 0 + receipt.
 */
import { crashPoint } from "./crash.ts";
import { holdTransferItem } from "./steward-transfer.ts";
import type { ReceiptHit } from "./steward-types.ts";
import type { Store } from "./store.ts";

export type AdoptFindReceipt = (o: {
	outboxId: number;
	deliveryId: string;
	landedAt: number;
}) => ReceiptHit | undefined;

export type AdoptResult = {
	adopted: number;
	receipted: number;
	unrecoverable: number;
	transferItems: number;
};

/** Ensure a standing transfer from gen 0 to the current generation exists. */
function ensureGen0Transfer(store: Store, now: number): void {
	const toGen = store.steward.maxGen();
	if (toGen < 1) return;
	if (store.steward.transfer(0)) return;
	store.tx(() => {
		store.steward.insertTransfer({
			fromGen: 0,
			toGen,
			receiptHw: store.steward.maxReceiptId(),
			noticeId: `adopt-notice:g0→g${toGen}`,
			openedAt: now,
		});
	});
}

/** Adopt every delivered Steward row that has no ledger entry. Idempotent. */
export function adoptPass(store: Store, find: AdoptFindReceipt, now = Date.now()): AdoptResult {
	const result: AdoptResult = { adopted: 0, receipted: 0, unrecoverable: 0, transferItems: 0 };
	const rows = store.steward.deliveredStewardWithoutLedger();
	if (!rows.length) return result;
	ensureGen0Transfer(store, now);
	for (const raw of rows) {
		const outboxId = raw.id as number;
		const deliveryId = raw.delivery_id as string;
		const message = (raw.message as string) ?? "";
		const createdAt = raw.created_at as number;
		adoptOne(store, find, { outboxId, deliveryId, message, createdAt, now, result });
	}
	return result;
}

function adoptOne(
	store: Store,
	find: AdoptFindReceipt,
	o: {
		outboxId: number;
		deliveryId: string;
		message: string;
		createdAt: number;
		now: number;
		result: AdoptResult;
	},
): void {
	const { outboxId, deliveryId, message, createdAt, now, result } = o;
	if (!message.trim()) {
		store.tx(() => {
			store.steward.insertLedger({ outboxId, gen: 0, origin: "unrecoverable" });
			crashPoint("adopted");
		});
		result.unrecoverable++;
		result.adopted++;
		return;
	}
	const hit = find({ outboxId, deliveryId, landedAt: createdAt });
	store.tx(() => {
		store.steward.insertLedger({ outboxId, gen: 0, origin: "adopted" });
		if (hit) {
			store.steward.insertReceipt({
				outboxId,
				kind: "t3-run",
				runId: hit.runId,
				thread: hit.thread,
				recordedAt: hit.recordedAt,
			});
			result.receipted++;
		}
		crashPoint("adopted");
	});
	result.adopted++;
	if (!hit) {
		const id = holdTransferItem(store, { fromGen: 0, origOutboxId: outboxId, adoption: true }, now);
		if (id) result.transferItems++;
	}
}

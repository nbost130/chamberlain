/**
 * Adoption of pre-upgrade Steward delivered rows (B3): runs at every daemon start under the relay lock.
 * Pre-v2 delivered rows (id ≤ steward.adopt.historical_hi) → adopted-historical, settled, no transfer.
 * Post-watermark rows: empty → unrecoverable; payload without receipt → gen 0 standing transfer; receipt → gen 0 + receipt.
 */
import { crashPoint } from "./crash.ts";
import { holdTransferItem, transferItemId } from "./steward-transfer.ts";
import { exceedsEncodedCap, HISTORICAL_ADOPT_HI_KEY, type ReceiptHit } from "./steward-types.ts";
import type { Store } from "./store.ts";

export type AdoptFindReceipt = (o: {
	outboxId: number;
	deliveryId: string;
	landedAt: number;
}) => ReceiptHit | undefined;

export type AdoptResult = {
	adopted: number;
	historical: number;
	receipted: number;
	unrecoverable: number;
	transferItems: number;
	notice: boolean;
};

const HISTORICAL_NOTICE_ID = "adopt-historical-notice";

/** Durable pre-v2 watermark: set by migration 16; computed once if missing (tests / odd restores). */
export function historicalAdoptHi(store: Store): number {
	const raw = store.state.get<number | string>(HISTORICAL_ADOPT_HI_KEY);
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
	const hi = store.wakes
		.rows("delivered", null)
		.filter((r) => r.attemptGen === undefined)
		.reduce((m, r) => Math.max(m, r.id), 0);
	store.state.set(HISTORICAL_ADOPT_HI_KEY, hi);
	return hi;
}

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

/** Drop gen-0 transfer item + held wake for a remediated historical row. */
function dropGen0Transfer(store: Store, outboxId: number): void {
	const itemId = transferItemId(outboxId, 0);
	const existing = store.steward.transferItemForOrig(0, outboxId);
	store.steward.dropTransferItem(existing?.itemId ?? itemId);
}

/** One short Steward notice with counts (optional, under the encoded size bound). Idempotent. */
function maybeHistoricalNotice(store: Store, historical: number, now: number): boolean {
	if (historical <= 0) return false;
	if (store.wakes.known(HISTORICAL_NOTICE_ID)) return false;
	const message = `Adopted ${historical} historical wakes, none replayed.`;
	if (exceedsEncodedCap(message, HISTORICAL_NOTICE_ID)) return false;
	store.tx(() => {
		store.wakes.enqueue({
			deliveryId: HISTORICAL_NOTICE_ID,
			message,
			queuedAt: now,
			kind: "adopt_notice",
		});
		const row = store.wakes.find(HISTORICAL_NOTICE_ID);
		if (row && store.steward.maxGen() >= 1) {
			store.steward.insertLedger({ outboxId: row.id, gen: store.steward.maxGen(), origin: "live" });
		}
	});
	return true;
}

/**
 * Remedi ate gen-0 adopted/unrecoverable rows at or below the watermark (a database that already ran v0.4.0's adoptPass).
 * Idempotent: already-historical rows are skipped.
 */
function remediateHistorical(store: Store, hi: number, result: AdoptResult): void {
	for (const outboxId of store.steward.gen0NeedingHistorical(hi)) {
		store.tx(() => {
			store.steward.setLedgerOrigin(outboxId, "adopted-historical");
			dropGen0Transfer(store, outboxId);
			crashPoint("adopted");
		});
		result.historical++;
		result.adopted++;
	}
}

/** Adopt every delivered Steward row that has no ledger entry. Idempotent. */
export function adoptPass(store: Store, find: AdoptFindReceipt, now = Date.now()): AdoptResult {
	const result: AdoptResult = {
		adopted: 0,
		historical: 0,
		receipted: 0,
		unrecoverable: 0,
		transferItems: 0,
		notice: false,
	};
	const hi = historicalAdoptHi(store);
	remediateHistorical(store, hi, result);

	for (const raw of store.steward.deliveredStewardWithoutLedger()) {
		const outboxId = raw.id as number;
		const deliveryId = raw.delivery_id as string;
		const message = (raw.message as string) ?? "";
		const createdAt = raw.created_at as number;
		if (outboxId <= hi) {
			store.tx(() => {
				store.steward.insertLedger({ outboxId, gen: 0, origin: "adopted-historical" });
				crashPoint("adopted");
			});
			result.historical++;
			result.adopted++;
			continue;
		}
		adoptOne(store, find, { outboxId, deliveryId, message, createdAt, now, result });
	}

	result.notice = maybeHistoricalNotice(store, result.historical, now);
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
		ensureGen0Transfer(store, now);
		const id = holdTransferItem(store, { fromGen: 0, origOutboxId: outboxId, adoption: true }, now);
		if (id) result.transferItems++;
	}
}

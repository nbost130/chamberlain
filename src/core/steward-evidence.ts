/**
 * Evidence pass: record receipts for undischarged Steward deliveries from a T3 projection finder.
 * A digest's receipt covers its envelope (membership propagates discharge).
 */
import { crashPoint } from "./crash.ts";
import { isDischarged } from "./steward-discharge.ts";
import type { ReceiptHit } from "./steward-types.ts";
import type { Store } from "./store.ts";
import type { OutboxRow } from "./store-wakes.ts";

export type EvidenceFinder = (o: {
	outboxId: number;
	deliveryId: string;
	landedAt: number;
	threads?: string[];
}) => ReceiptHit | undefined;

function shouldScan(store: Store, row: OutboxRow, filterGen: number | undefined): boolean {
	const led = store.steward.ledger(row.id);
	if (!led || led.origin === "unrecoverable") return false;
	if (filterGen !== undefined && led.gen !== filterGen) return false;
	return !isDischarged(store, row.id);
}

function recordHit(store: Store, row: OutboxRow, hit: ReceiptHit, now: number): void {
	store.tx(() => {
		store.steward.insertReceipt({
			outboxId: row.id,
			kind: "t3-run",
			runId: hit.runId,
			thread: hit.thread,
			recordedAt: hit.recordedAt || now,
		});
		crashPoint("receipt-recorded");
	});
}

/** Record receipts found for undischarged Steward delivered rows of the current (or given) generation. */
export function evidencePass(store: Store, find: EvidenceFinder, o: { now?: number; gen?: number } = {}): number {
	const now = o.now ?? Date.now();
	const gen = o.gen ?? store.steward.maxGen();
	const current = store.steward.gen(gen);
	const threads = current ? [current.thread] : undefined;
	let n = 0;
	for (const row of store.wakes.rows("delivered", null)) {
		if (!shouldScan(store, row, o.gen)) continue;
		const hit = find({
			outboxId: row.id,
			deliveryId: row.deliveryId,
			landedAt: row.finishedAt ?? row.createdAt,
			...(threads ? { threads } : {}),
		});
		if (!hit) continue;
		recordHit(store, row, hit, now);
		n++;
	}
	return n;
}

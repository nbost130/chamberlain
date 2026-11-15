/** SQL accessors for Steward switch tables (migration 15). */
import type { Db, Row } from "./sqlite-db.ts";
import type {
	ReceiptKind,
	StewardDelivery,
	StewardGen,
	StewardOrigin,
	StewardReceipt,
	StewardSwitch,
	StewardTransfer,
	SwitchPhase,
	TransferItem,
} from "./steward-types.ts";

const toGen = (r: Row): StewardGen => ({
	gen: r.gen as number,
	thread: r.thread as string,
	wakeRef: r.wake_ref as string,
	...(r.compact_ref != null ? { compactRef: r.compact_ref as string } : {}),
	createdAt: r.created_at as number,
});

const toSwitch = (r: Row): StewardSwitch => ({
	id: r.id as string,
	fromGen: r.from_gen as number,
	toThread: r.to_thread as string,
	...(r.rollback_of != null ? { rollbackOf: r.rollback_of as number } : {}),
	phase: r.phase as SwitchPhase,
	preparedAt: r.prepared_at as number,
	...(r.to_gen != null ? { toGen: r.to_gen as number } : {}),
});

const toReceipt = (r: Row): StewardReceipt => ({
	id: r.id as number,
	outboxId: r.outbox_id as number,
	kind: r.kind as ReceiptKind,
	...(r.run_id != null ? { runId: r.run_id as string } : {}),
	...(r.thread != null ? { thread: r.thread as string } : {}),
	recordedAt: r.recorded_at as number,
});

const toTransfer = (r: Row): StewardTransfer => ({
	fromGen: r.from_gen as number,
	toGen: r.to_gen as number,
	receiptHw: r.receipt_hw as number,
	noticeId: r.notice_id as string,
	openedAt: r.opened_at as number,
	...(r.sealed_at != null ? { sealedAt: r.sealed_at as number } : {}),
	...(r.closed_at != null ? { closedAt: r.closed_at as number } : {}),
});

const toItem = (r: Row): TransferItem => ({
	itemId: r.item_id as string,
	fromGen: r.from_gen as number,
	origOutboxId: r.orig_outbox_id as number,
	rootOutboxId: r.root_outbox_id as number,
});

function gensApi(c: Db) {
	return {
		maxGen: (): number => (c.one("SELECT MAX(gen) AS g FROM steward_gens")?.g as number | null) ?? 0,
		gen: (g: number) => {
			const r = c.one("SELECT * FROM steward_gens WHERE gen = ?", g);
			return r ? toGen(r) : undefined;
		},
		current: (): StewardGen | undefined => {
			const r = c.one("SELECT * FROM steward_gens ORDER BY gen DESC LIMIT 1");
			return r ? toGen(r) : undefined;
		},
		insertGen: (g: StewardGen) => {
			c.run(
				"INSERT INTO steward_gens (gen, thread, wake_ref, compact_ref, created_at) VALUES (?, ?, ?, ?, ?)",
				g.gen,
				g.thread,
				g.wakeRef,
				g.compactRef ?? null,
				g.createdAt,
			);
		},
	};
}

function switchesApi(c: Db) {
	return {
		switchById: (id: string) => {
			const r = c.one("SELECT * FROM steward_switches WHERE id = ?", id);
			return r ? toSwitch(r) : undefined;
		},
		openSwitch: () => {
			const r = c.one("SELECT * FROM steward_switches WHERE phase = 'preparing' LIMIT 1");
			return r ? toSwitch(r) : undefined;
		},
		insertSwitch: (s: StewardSwitch) => {
			c.run(
				`INSERT INTO steward_switches (id, from_gen, to_thread, rollback_of, phase, prepared_at, to_gen)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				s.id,
				s.fromGen,
				s.toThread,
				s.rollbackOf ?? null,
				s.phase,
				s.preparedAt,
				s.toGen ?? null,
			);
		},
		setSwitchPhase: (id: string, phase: SwitchPhase, toGen?: number) => {
			if (toGen !== undefined)
				c.run("UPDATE steward_switches SET phase = ?, to_gen = ? WHERE id = ?", phase, toGen, id);
			else c.run("UPDATE steward_switches SET phase = ? WHERE id = ?", phase, id);
		},
		committedSwitches: () =>
			c.all("SELECT * FROM steward_switches WHERE phase = 'committed' ORDER BY prepared_at").map(toSwitch),
	};
}

function ledgerApi(c: Db) {
	return {
		ledger: (outboxId: number): StewardDelivery | undefined => {
			const r = c.one("SELECT * FROM steward_deliveries WHERE outbox_id = ?", outboxId);
			return r
				? { outboxId: r.outbox_id as number, gen: r.gen as number, origin: r.origin as StewardOrigin }
				: undefined;
		},
		insertLedger: (d: StewardDelivery) => {
			c.run(
				"INSERT OR IGNORE INTO steward_deliveries (outbox_id, gen, origin) VALUES (?, ?, ?)",
				d.outboxId,
				d.gen,
				d.origin,
			);
		},
		/** Rewrite origin (remediation of exact-set members wrongly ledgered as adopted/unrecoverable). */
		setLedgerOrigin: (outboxId: number, origin: StewardOrigin) => {
			c.run("UPDATE steward_deliveries SET origin = ? WHERE outbox_id = ?", origin, outboxId);
		},
		receiptFor: (outboxId: number) => {
			const r = c.one("SELECT * FROM steward_receipts WHERE outbox_id = ?", outboxId);
			return r ? toReceipt(r) : undefined;
		},
		maxReceiptId: (): number => (c.one("SELECT MAX(id) AS m FROM steward_receipts")?.m as number | null) ?? 0,
		insertReceipt: (o: {
			outboxId: number;
			kind: ReceiptKind;
			runId?: string;
			thread?: string;
			recordedAt: number;
		}) => {
			c.run(
				"INSERT OR IGNORE INTO steward_receipts (outbox_id, kind, run_id, thread, recorded_at) VALUES (?, ?, ?, ?, ?)",
				o.outboxId,
				o.kind,
				o.runId ?? null,
				o.thread ?? null,
				o.recordedAt,
			);
		},
	};
}

function transfersApi(c: Db) {
	return {
		transfer: (fromGen: number) => {
			const r = c.one("SELECT * FROM steward_transfers WHERE from_gen = ?", fromGen);
			return r ? toTransfer(r) : undefined;
		},
		openTransfers: () =>
			c.all("SELECT * FROM steward_transfers WHERE closed_at IS NULL ORDER BY from_gen").map(toTransfer),
		insertTransfer: (t: StewardTransfer) => {
			c.run(
				`INSERT INTO steward_transfers (from_gen, to_gen, receipt_hw, notice_id, opened_at, sealed_at, closed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				t.fromGen,
				t.toGen,
				t.receiptHw,
				t.noticeId,
				t.openedAt,
				t.sealedAt ?? null,
				t.closedAt ?? null,
			);
		},
		sealTransfer: (fromGen: number, at: number) => {
			c.run("UPDATE steward_transfers SET sealed_at = ? WHERE from_gen = ? AND sealed_at IS NULL", at, fromGen);
		},
		closeTransfer: (fromGen: number, at: number) => {
			c.run("UPDATE steward_transfers SET closed_at = ? WHERE from_gen = ? AND closed_at IS NULL", at, fromGen);
		},
		transferItem: (itemId: string) => {
			const r = c.one("SELECT * FROM transfer_items WHERE item_id = ?", itemId);
			return r ? toItem(r) : undefined;
		},
		transferItemForOrig: (fromGen: number, origOutboxId: number) => {
			const r = c.one("SELECT * FROM transfer_items WHERE from_gen = ? AND orig_outbox_id = ?", fromGen, origOutboxId);
			return r ? toItem(r) : undefined;
		},
		insertTransferItem: (i: TransferItem) => {
			c.run(
				"INSERT OR IGNORE INTO transfer_items (item_id, from_gen, orig_outbox_id, root_outbox_id) VALUES (?, ?, ?, ?)",
				i.itemId,
				i.fromGen,
				i.origOutboxId,
				i.rootOutboxId,
			);
		},
		itemsOfTransfer: (fromGen: number) =>
			c.all("SELECT * FROM transfer_items WHERE from_gen = ? ORDER BY orig_outbox_id", fromGen).map(toItem),
		/** Drop a transfer item and its held wake (historical remediation). Idempotent. */
		dropTransferItem: (itemId: string) => {
			c.run("DELETE FROM held_wakes WHERE delivery_id = ?", itemId);
			c.run("DELETE FROM transfer_items WHERE item_id = ?", itemId);
		},
	};
}

function attemptApi(c: Db) {
	return {
		clearAttemptGen: (id: number) => {
			c.run("UPDATE outbox SET attempt_gen = NULL WHERE id = ? AND status = 'pending'", id);
		},
		clearAllAttemptGens: () => {
			c.run("UPDATE outbox SET attempt_gen = NULL WHERE status = 'pending' AND attempt_gen IS NOT NULL");
		},
		stampAttemptGen: (id: number, gen: number) => {
			c.run("UPDATE outbox SET attempt_gen = ? WHERE id = ? AND status = 'pending'", gen, id);
		},
		pendingWithAttemptGen: (gen: number) =>
			c.all("SELECT id FROM outbox WHERE status = 'pending' AND attempt_gen = ?", gen).map((r) => r.id as number),
		undischargedSteward: (): number[] =>
			c
				.all(
					`SELECT o.id FROM outbox o
					 JOIN steward_deliveries d ON d.outbox_id = o.id
					 WHERE o.status = 'delivered' AND o.receiver IS NULL
					   AND d.origin NOT IN ('unrecoverable', 'adopted-historical')
					   AND NOT EXISTS (SELECT 1 FROM steward_receipts r WHERE r.outbox_id = o.id)
					   AND NOT EXISTS (
					     SELECT 1 FROM transfer_items ti
					     JOIN outbox_members m ON m.delivery_id = ti.item_id
					     JOIN steward_receipts r2 ON r2.outbox_id = m.outbox_id
					     WHERE ti.root_outbox_id = o.id OR ti.orig_outbox_id = o.id
					   )`,
				)
				.map((r) => r.id as number),
		deliveredStewardWithoutLedger: () =>
			c.all(
				`SELECT o.id, o.delivery_id, o.message, o.created_at, o.kind, o.folded
				 FROM outbox o
				 WHERE o.status = 'delivered' AND o.receiver IS NULL
				   AND NOT EXISTS (SELECT 1 FROM steward_deliveries d WHERE d.outbox_id = o.id)
				 ORDER BY o.id`,
			),
	};
}

export type StewardSql = ReturnType<typeof makeStewardSql>;

export function makeStewardSql(c: Db) {
	return { ...gensApi(c), ...switchesApi(c), ...ledgerApi(c), ...transfersApi(c), ...attemptApi(c) };
}

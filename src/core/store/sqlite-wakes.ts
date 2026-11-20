/** The wake outbox, held wakes and confirmation challenges. */

import { exceedsEncodedCap } from "../steward/steward-types.ts";
import { type Db, type Row, required } from "./sqlite-db.ts";
import type { Store } from "./store.ts";
import type { Composed, HeldItem, Lane, OutboxRow, OutboxStatus, Parked, RightsStamp, WakeRow } from "./store-wakes.ts";

// ---- wakes --------------------------------------------------------------------------------------
/** The stamps a row or held item carries (migration 9): a JSON array, or nothing. Unreadable is treated as a stamp nothing matches, so the relay sends the full rights ahead of it: doubt sends them again. */
const stampsOf = (r: Row): { rights?: RightsStamp[] } => {
	if (r.rights_for === null || r.rights_for === undefined) return {};
	try {
		const v = JSON.parse(r.rights_for as string);
		if (Array.isArray(v) && v.length) return { rights: v as RightsStamp[] };
	} catch {}
	return { rights: [{ hash: "" }] };
};
const stampText = (w: { rights?: RightsStamp[] }) => (w.rights?.length ? JSON.stringify(w.rights) : null);
/** The kind, thread and receiver a wake row or held item carries, when it has them. */
const wakeTags = (r: Row): { kind?: string; thread?: string; receiver?: string } => ({
	...(r.kind ? { kind: r.kind as string } : {}),
	...(r.thread ? { thread: r.thread as string } : {}),
	...(r.receiver ? { receiver: r.receiver as string } : {}),
});
/**
 * A parked wake's record (migration 21). `held()` leaves out every row whose column is set, so a record that cannot be read must not
 * become "no record" (the wake would be in neither list and never sent): it is a record due at once, which the next tick releases.
 */
const parkedOf = (r: Row): { parked?: Parked } => {
	if (r.parked === null || r.parked === undefined) return {};
	let v: Partial<Parked> | null = null;
	try {
		v = JSON.parse(r.parked as string) as Partial<Parked> | null;
	} catch {}
	const at = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
	return {
		parked: {
			releaseAt: at(v?.releaseAt) ?? 0,
			lastWriteAt: at(v?.lastWriteAt) ?? (r.queued_at as number),
			server: typeof v?.server === "string" ? v.server : "",
			requestIds: Array.isArray(v?.requestIds) ? v.requestIds.filter((x): x is string => typeof x === "string") : [],
		},
	};
};
const toHeld = (r: Row): HeldItem => ({
	deliveryId: r.delivery_id as string,
	message: (r.message as string | undefined) ?? "",
	queuedAt: r.queued_at as number,
	...wakeTags(r),
	...stampsOf(r),
	...parkedOf(r),
});
const toOutboxRow = (c: Db, r: Row): OutboxRow => ({
	id: r.id as number,
	deliveryId: r.delivery_id as string,
	message: r.message as string,
	...wakeTags(r),
	...stampsOf(r),
	createdAt: r.created_at as number,
	folded: r.folded as number,
	status: r.status as OutboxStatus,
	attempts: r.attempts as number,
	...(r.last_attempt_at !== null ? { lastAttemptAt: r.last_attempt_at as number } : {}),
	...(r.finished_at !== null ? { finishedAt: r.finished_at as number } : {}),
	...(r.attempt_gen !== null && r.attempt_gen !== undefined ? { attemptGen: r.attempt_gen as number } : {}),
	members: c.all("SELECT * FROM outbox_members WHERE outbox_id = ? ORDER BY queued_at, rowid", r.id).map(toHeld),
});
// Known: bound to a row, held, or tombstoned (delivered or cancelled, even after retention deleted its row).
const knownWake = (c: Db, id: string) =>
	c.one(
		"SELECT 1 AS x FROM outbox_members WHERE delivery_id = ? UNION ALL SELECT 1 FROM held_wakes WHERE delivery_id = ? UNION ALL SELECT 1 FROM wake_tombstones WHERE delivery_id = ?",
		id,
		id,
		id,
	) !== undefined;
const findWake = (c: Db, id: string) => {
	const r = c.one(
		"SELECT o.* FROM outbox o WHERE o.delivery_id = ? OR o.id = (SELECT outbox_id FROM outbox_members WHERE delivery_id = ?)",
		id,
		id,
	);
	return r ? toOutboxRow(c, r) : undefined;
};
/** Inserts a row and binds its members, inside the caller's transaction. */
function insertRow(c: Db, w: WakeRow & { folded?: number }, members: HeldItem[]): number {
	const id = c.run(
		"INSERT INTO outbox (delivery_id, message, kind, thread, receiver, rights_for, created_at, folded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		w.deliveryId,
		w.message,
		w.kind ?? null,
		w.thread ?? null,
		w.receiver ?? null,
		stampText(w),
		w.queuedAt,
		w.folded ?? 0,
	).lastInsertRowid as number;
	for (const m of members)
		c.run(
			"INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, ?, ?)",
			m.deliveryId,
			id,
			m.queuedAt,
			m.kind ?? null,
			m.thread ?? null,
		);
	return id;
}

/** The held wakes the relay composes (`parked` is NULL), or, with `parked`, the question cards held for the principal. */
const heldWakes = (c: Db, lane?: Lane, parked = false): HeldItem[] => {
	const only = parked ? "parked IS NOT NULL" : "parked IS NULL";
	return (
		lane === undefined
			? c.all(`SELECT * FROM held_wakes WHERE ${only} ORDER BY seq`)
			: c.all(`SELECT * FROM held_wakes WHERE ${only} AND receiver IS ? ORDER BY seq`, lane)
	).map(toHeld);
};

function unparkWake(c: Db, id: string, now: number, message: string): OutboxRow | undefined {
	return c.tx(() => {
		const item = heldWakes(c, undefined, true).find((h) => h.deliveryId === id);
		if (!item) return undefined;
		const { parked: _parked, ...plain } = item;
		const rowId = insertRow(c, { ...plain, message, queuedAt: now }, [{ ...plain, message }]);
		c.run("DELETE FROM held_wakes WHERE delivery_id = ?", id);
		return toOutboxRow(c, required(c.one("SELECT * FROM outbox WHERE id = ?", rowId), `outbox row ${rowId}`));
	});
}

function holdWake(c: Db, w: HeldItem): boolean {
	return c.tx(() => {
		if (knownWake(c, w.deliveryId)) return false;
		c.run(
			"INSERT INTO held_wakes (delivery_id, message, queued_at, kind, thread, receiver, rights_for, parked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			w.deliveryId,
			w.message,
			w.queuedAt,
			w.kind ?? null,
			w.thread ?? null,
			w.receiver ?? null,
			stampText(w),
			w.parked ? JSON.stringify(w.parked) : null,
		);
		return true;
	});
}

function composeHeld(c: Db, now: number, compose: (held: HeldItem[]) => Composed, lane?: Lane): OutboxRow | undefined {
	return c.tx(() => {
		const held = heldWakes(c, lane);
		if (!held.length) return undefined;
		const composed = compose(held);
		const members = held.filter((h) => composed.members.includes(h.deliveryId));
		const id = insertRow(c, { ...composed, queuedAt: now }, members);
		for (const m of members) c.run("DELETE FROM held_wakes WHERE delivery_id = ?", m.deliveryId);
		return toOutboxRow(c, required(c.one("SELECT * FROM outbox WHERE id = ?", id), `outbox row ${id}`));
	});
}

function outboxRows(c: Db, status: OutboxStatus | "all" = "pending", lane?: Lane): OutboxRow[] {
	return (
		lane === undefined
			? status === "all"
				? c.all("SELECT * FROM outbox ORDER BY id")
				: c.all("SELECT * FROM outbox WHERE status = ? ORDER BY id", status)
			: status === "all"
				? c.all("SELECT * FROM outbox WHERE receiver IS ? ORDER BY id", lane)
				: c.all("SELECT * FROM outbox WHERE status = ? AND receiver IS ? ORDER BY id", status, lane)
	).map((r) => toOutboxRow(c, r));
}

function retryWake(c: Db, id: string): OutboxStatus | "oversized" | undefined {
	return c.tx(() => {
		const r = findWake(c, id);
		if (r?.status !== "dead_letter") return r?.status;
		// Oversized frozen payloads must not re-enter the send path (R2): leave them dead_letter.
		// Distinct from success (which also returns the prior "dead_letter") so the CLI can refuse clearly (R3).
		if (exceedsEncodedCap(r.message, r.deliveryId)) return "oversized";
		c.run(
			"UPDATE outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, finished_at = NULL WHERE id = ?",
			r.id,
		);
		return r.status;
	});
}

function cancelWake(c: Db, id: string, now: number): OutboxStatus | undefined {
	return c.tx(() => {
		const r = findWake(c, id);
		if (r && (r.status === "pending" || r.status === "dead_letter"))
			c.run("UPDATE outbox SET status = 'cancelled', finished_at = ? WHERE id = ?", now, r.id);
		return r?.status;
	});
}

export const makeWakes = (c: Db): Store["wakes"] => ({
	enqueue: (w) =>
		c.tx(() => {
			if (knownWake(c, w.deliveryId)) return false;
			insertRow(c, w, [w]);
			return true;
		}),
	hold: (w) => holdWake(c, w),
	held: (lane) => heldWakes(c, lane),
	parked: (lane) => heldWakes(c, lane, true),
	unpark: (id, now, message) => unparkWake(c, id, now, message),
	dropParked: (id) => c.run("DELETE FROM held_wakes WHERE delivery_id = ? AND parked IS NOT NULL", id).changes === 1,
	compose: (now, compose, lane) => composeHeld(c, now, compose, lane),
	rows: (status, lane) => outboxRows(c, status, lane),
	find: (id) => findWake(c, id),
	byId: (id) => {
		const r = c.one("SELECT * FROM outbox WHERE id = ?", id);
		return r ? toOutboxRow(c, r) : undefined;
	},
	isDelivered: (id) =>
		(findWake(c, id)?.status ??
			(c.one("SELECT outcome FROM wake_tombstones WHERE delivery_id = ?", id)?.outcome as string | undefined)) ===
		"delivered",
	known: (id) => knownWake(c, id),
	beginAttempt: (id, now, expectGen) => beginAttemptRow(c, id, now, expectGen),
	finish: (id, status, now) =>
		c.run("UPDATE outbox SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'", status, now, id)
			.changes === 1,
	retry: (id) => retryWake(c, id),
	cancel: (id, now) => cancelWake(c, id, now),
	// Terminal rows only; Steward-lane delivered also need discharge or origin=unrecoverable (B2). Tombstones remain.
	prune: (before) => pruneWakes(c, before),
});

function beginAttemptRow(c: Db, id: number, now: number, expectGen?: number): number | undefined {
	if (expectGen !== undefined) {
		const max = (c.one("SELECT MAX(gen) AS g FROM steward_gens")?.g as number | null) ?? 0;
		if (max !== expectGen) return undefined;
	}
	const n = c.one(
		"UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'pending' RETURNING attempts",
		now,
		id,
	)?.attempts as number | undefined;
	if (n !== undefined && expectGen !== undefined)
		c.run("UPDATE outbox SET attempt_gen = ? WHERE id = ? AND status = 'pending'", expectGen, id);
	return n;
}

/** Counting receipt for one outbox id: own ledger gen's transfer cutoff (same predicate as steward-discharge). */
const COUNTING_RECEIPT_SQL = `(
	EXISTS (
		SELECT 1 FROM steward_receipts r
		JOIN steward_deliveries d ON d.outbox_id = r.outbox_id
		LEFT JOIN steward_transfers t ON t.from_gen = d.gen
		WHERE r.outbox_id = $oid
			AND (t.from_gen IS NULL OR r.id <= t.receipt_hw OR (r.kind = 't3-run' AND r.recorded_at <= t.opened_at - 60000))
	)
)`;

function pruneWakes(c: Db, before: number): number {
	// Steward-lane delivered rows prune only when ledgered and counting-discharged (or unrecoverable).
	// Unledgered Steward rows never prune. Desk/cancelled prune as before.
	// A pruned row's receipt goes with it: SQLite reuses the highest row number once that row is deleted, and a new wake under the old number
	// must never inherit its receipt. (A discharged root that is gone already counts as discharged: steward-discharge.ts.)
	return c.tx(() => {
		const n = c.run(
			`DELETE FROM outbox WHERE status IN ('delivered', 'cancelled') AND finished_at < ?
			 AND id NOT IN (SELECT m.outbox_id FROM outbox_members m JOIN claims c ON c.delivery_id = m.delivery_id JOIN items i ON i.id = c.item_id WHERE i.state != 'resolved')
			 AND (
			   receiver IS NOT NULL
			   OR status = 'cancelled'
			   OR EXISTS (
			     SELECT 1 FROM steward_deliveries d WHERE d.outbox_id = outbox.id AND (
			       d.origin = 'unrecoverable'
			       OR ${COUNTING_RECEIPT_SQL.replaceAll("$oid", "outbox.id")}
			       OR EXISTS (
			         SELECT 1 FROM transfer_items ti
			         JOIN outbox_members m ON m.delivery_id = ti.item_id
			         WHERE (ti.root_outbox_id = outbox.id OR ti.orig_outbox_id = outbox.id)
			           AND ${COUNTING_RECEIPT_SQL.replaceAll("$oid", "m.outbox_id")}
			       )
			     )
			   )
			 )`,
			before,
		).changes;
		c.run("DELETE FROM steward_receipts WHERE outbox_id NOT IN (SELECT id FROM outbox)");
		return n;
	});
}

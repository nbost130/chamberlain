/** The wake outbox, held wakes and confirmation challenges. */

import { type Db, type Row, required } from "./sqlite-db.ts";
import type { Store } from "./store.ts";
import type {
	Challenge,
	ChallengeVerdict,
	Composed,
	HeldItem,
	Lane,
	OutboxRow,
	OutboxStatus,
	RightsStamp,
	WakeRow,
} from "./store-wakes.ts";

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
const toHeld = (r: Row): HeldItem => ({
	deliveryId: r.delivery_id as string,
	message: (r.message as string | undefined) ?? "",
	queuedAt: r.queued_at as number,
	...wakeTags(r),
	...stampsOf(r),
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

const heldWakes = (c: Db, lane?: Lane): HeldItem[] =>
	(lane === undefined
		? c.all("SELECT * FROM held_wakes ORDER BY seq")
		: c.all("SELECT * FROM held_wakes WHERE receiver IS ? ORDER BY seq", lane)
	).map(toHeld);

function holdWake(c: Db, w: HeldItem): boolean {
	return c.tx(() => {
		if (knownWake(c, w.deliveryId)) return false;
		c.run(
			"INSERT INTO held_wakes (delivery_id, message, queued_at, kind, thread, receiver, rights_for) VALUES (?, ?, ?, ?, ?, ?, ?)",
			w.deliveryId,
			w.message,
			w.queuedAt,
			w.kind ?? null,
			w.thread ?? null,
			w.receiver ?? null,
			stampText(w),
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

function retryWake(c: Db, id: string): OutboxStatus | undefined {
	return c.tx(() => {
		const r = findWake(c, id);
		if (r?.status === "dead_letter")
			c.run(
				"UPDATE outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, finished_at = NULL WHERE id = ?",
				r.id,
			);
		return r?.status;
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
	compose: (now, compose, lane) => composeHeld(c, now, compose, lane),
	rows: (status, lane) => outboxRows(c, status, lane),
	find: (id) => findWake(c, id),
	isDelivered: (id) =>
		(findWake(c, id)?.status ??
			(c.one("SELECT outcome FROM wake_tombstones WHERE delivery_id = ?", id)?.outcome as string | undefined)) ===
		"delivered",
	known: (id) => knownWake(c, id),
	beginAttempt: (id, now) =>
		c.one(
			"UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'pending' RETURNING attempts",
			now,
			id,
		)?.attempts as number | undefined,
	finish: (id, status, now) =>
		c.run("UPDATE outbox SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'", status, now, id)
			.changes === 1,
	retry: (id) => retryWake(c, id),
	cancel: (id, now) => cancelWake(c, id, now),
	// Only a terminal row goes: a delivered or cancelled row that no unresolved claim still names. Its ids stay in wake_tombstones (migration 7), which is what stops them being enqueued again.
	prune: (before) =>
		c.run(
			`DELETE FROM outbox WHERE status IN ('delivered', 'cancelled') AND finished_at < ?
				 AND id NOT IN (SELECT m.outbox_id FROM outbox_members m JOIN claims c ON c.delivery_id = m.delivery_id JOIN items i ON i.id = c.item_id WHERE i.state != 'resolved')`,
			before,
		).changes,
});

// ---- confirmation challenges --------------------------------------------------------------------
function issueChallenge(c: Db, ch: Challenge): void {
	c.tx(() => {
		c.run(
			"DELETE FROM confirmation_challenges WHERE card_id = ? AND session_hash = ? AND consumed_at IS NULL",
			ch.cardId,
			ch.sessionHash,
		);
		c.run(
			"INSERT INTO confirmation_challenges (token_hash, card_id, sig, choice, session_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			ch.tokenHash,
			ch.cardId,
			ch.sig,
			ch.choice,
			ch.sessionHash,
			ch.issuedAt,
			ch.expiresAt,
		);
	});
}

function consumeChallenge(
	c: Db,
	tokenHash: string,
	expect: { cardId: string; sig: string; choice: number; sessionHash: string },
	now: number,
): ChallengeVerdict {
	return c.tx(() => {
		const r = c.one("SELECT * FROM confirmation_challenges WHERE token_hash = ?", tokenHash);
		if (!r) return "unknown";
		if (r.consumed_at !== null) return "used";
		if ((r.expires_at as number) <= now) return "expired";
		if (
			r.card_id !== expect.cardId ||
			r.sig !== expect.sig ||
			r.choice !== expect.choice ||
			r.session_hash !== expect.sessionHash
		)
			return "mismatch";
		c.run(
			"UPDATE confirmation_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
			now,
			tokenHash,
		);
		return "ok";
	});
}

export const makeChallenges = (c: Db): Store["challenges"] => ({
	issue: (ch) => issueChallenge(c, ch),
	consume: (tokenHash, expect, now) => consumeChallenge(c, tokenHash, expect, now),
	prune: (before) =>
		c.run(
			"DELETE FROM confirmation_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)",
			before,
			before,
		).changes,
});

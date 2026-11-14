/** The items table: observe, resolve, acknowledge, patch, list and prune. The only writer of the items table and its notification columns. */
import { decideNotification, NOTIFY_ONCE } from "./notification.ts";
import { type Db, mergeInto, parse, type Row, required } from "./sqlite-db.ts";
import type { Item, ItemFilter, ItemStatus, Observation, Observed, Store } from "./store.ts";

// ---- items --------------------------------------------------------------------------------------
const toItem = (r: Row): Item => ({
	id: r.id as number,
	source: r.source as string,
	kind: r.kind as string,
	dedupKey: r.dedup_key as string,
	status: r.state as ItemStatus,
	mode: r.mode as Item["mode"],
	firstSeen: r.first_seen as number,
	lastSeen: r.last_seen as number,
	resolvedAt: (r.resolved_at as number | null) ?? null,
	notificationCount: r.notification_count as number,
	nextNotificationAt: (r.next_notification_at as number | null) ?? null,
	shadowNotificationCount: r.shadow_notification_count as number,
	shadowNextNotificationAt: (r.shadow_next_notification_at as number | null) ?? null,
	subject:
		r.subject_kind === null || r.subject_kind === undefined
			? null
			: { kind: r.subject_kind as string, id: r.subject_id as string },
	payload: parse<Record<string, unknown>>(r.payload) ?? {},
});
const itemRow = (c: Db, source: string, dedupKey: string) =>
	c.one("SELECT * FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
export const itemId = (c: Db, source: string, dedupKey: string): number => {
	const r = c.one("SELECT id FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
	if (!r) throw Error(`no item ${source}/${dedupKey}`);
	return r.id as number;
};
/** The item as it stands now, read back inside the transaction that has just found or written it. */
const currentItem = (c: Db, source: string, dedupKey: string): Item =>
	toItem(required(itemRow(c, source, dedupKey), `item ${source}/${dedupKey}`));

function insertItem(c: Db, o: Observation, mode: string, now: number): void {
	c.run(
		"INSERT INTO items (source, kind, dedup_key, state, mode, first_seen, last_seen, subject_kind, subject_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		o.source,
		o.kind,
		o.dedupKey,
		o.baseline ? "acknowledged" : "triggered",
		mode,
		now,
		now,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		JSON.stringify(o.payload ?? {}),
	);
}

/** A recurrence is a new occurrence: its notification counters start over. */
/** Where an observation lands on an existing item: its row, the mode it is observed in, and the time. */
type ItemAt = { id: unknown; mode: string; now: number };

function reopenItem(c: Db, o: Observation, { id, mode, now }: ItemAt): void {
	c.run(
		"UPDATE items SET state = ?, mode = ?, kind = ?, first_seen = ?, last_seen = ?, resolved_at = NULL, notification_count = 0, next_notification_at = NULL, shadow_notification_count = 0, shadow_next_notification_at = NULL, subject_kind = ?, subject_id = ?, payload = ? WHERE id = ?",
		o.baseline ? "acknowledged" : "triggered",
		mode,
		o.kind,
		now,
		now,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		JSON.stringify(o.payload ?? {}),
		id,
	);
}

function touchItem(c: Db, o: Observation, { id, mode, now }: ItemAt): void {
	c.run(
		"UPDATE items SET mode = ?, last_seen = ?, payload = COALESCE(?, payload), subject_kind = COALESCE(?, subject_kind), subject_id = COALESCE(?, subject_id) WHERE id = ?",
		mode,
		now,
		o.payload ? JSON.stringify(o.payload) : null,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		id,
	);
}

/** Records what the policy decided: the live counters when it notifies, the shadow ones when it only would have. */
function recordNotification(c: Db, id: number, d: ReturnType<typeof decideNotification>): void {
	if (d.notify)
		c.run("UPDATE items SET notification_count = ?, next_notification_at = ? WHERE id = ?", d.count, d.nextAt, id);
	else if (d.wouldNotify)
		c.run(
			"UPDATE items SET shadow_notification_count = ?, shadow_next_notification_at = ? WHERE id = ?",
			d.count,
			d.nextAt,
			id,
		);
}

function observeItem(c: Db, o: Observation): Observed {
	const now = o.now ?? Date.now();
	return c.tx(() => {
		const mode = o.mode ?? "live";
		const policy = o.repeat ?? NOTIFY_ONCE;
		let created = false,
			reopened = false;
		const prior = itemRow(c, o.source, o.dedupKey);
		if (!prior) {
			created = true;
			insertItem(c, o, mode, now);
		} else if (prior.state === "resolved") {
			reopened = true;
			reopenItem(c, o, { id: prior.id, mode, now });
		} else touchItem(c, o, { id: prior.id, mode, now });
		const cur = currentItem(c, o.source, o.dedupKey);
		const d = decideNotification(cur, policy, now);
		recordNotification(c, cur.id, d);
		return {
			item: currentItem(c, o.source, o.dedupKey),
			created,
			reopened,
			notify: d.notify,
			wouldNotify: d.wouldNotify,
		};
	});
}

function listItems(c: Db, f: ItemFilter = {}): Item[] {
	const where: string[] = [],
		p: unknown[] = [];
	if (f.source !== undefined) {
		where.push("source = ?");
		p.push(f.source);
	}
	if (f.kind !== undefined) {
		where.push("kind = ?");
		p.push(f.kind);
	}
	if (f.status !== undefined) {
		const s = Array.isArray(f.status) ? f.status : [f.status];
		where.push(`state IN (${s.map(() => "?").join(",")})`);
		p.push(...s);
	}
	if (f.subject) {
		where.push("subject_kind = ? AND subject_id = ?");
		p.push(f.subject.kind, f.subject.id);
	}
	return c
		.all(`SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`, ...p)
		.map(toItem);
}

/** The payload of row `r` with `patch` merged over it, as the JSON the column holds. */
const patchedPayload = (r: Row, patch: Record<string, unknown>) =>
	JSON.stringify(mergeInto(parse<Record<string, unknown>>(r.payload) ?? {}, patch));

/** In one transaction: the item's row passed to `change`, then the item as it stands; undefined when there is no such item. */
function changeItem(c: Db, source: string, dedupKey: string, change: (r: Row) => void): Item | undefined {
	return c.tx(() => {
		const r = itemRow(c, source, dedupKey);
		if (!r) return undefined;
		change(r);
		return currentItem(c, source, dedupKey);
	});
}

/** Which item to move, when, and what to merge into its payload. */
type ItemMove = { source: string; dedupKey: string; now: number; patch: Record<string, unknown> | undefined };

/** Moves an item to another state with `sql` (its placeholders: the time, the merged payload, the id), when `due` says its present state allows it. */
function moveItem(
	c: Db,
	{ source, dedupKey, now, patch }: ItemMove,
	move: { sql: string; due: (state: unknown) => boolean },
): Item | undefined {
	return changeItem(c, source, dedupKey, (r) => {
		if (move.due(r.state)) c.run(move.sql, now, patchedPayload(r, patch ?? {}), r.id);
	});
}

/** When an item moves and what its payload takes: the time (now when absent) and a patch merged over it. */
type MoveOptions = { now?: number; patch?: Record<string, unknown> };

const resolveItem = (c: Db, source: string, dedupKey: string, { now = Date.now(), patch }: MoveOptions = {}) =>
	moveItem(
		c,
		{ source, dedupKey, now, patch },
		{
			sql: "UPDATE items SET state = 'resolved', resolved_at = ?, payload = ? WHERE id = ?",
			due: (state) => state !== "resolved",
		},
	);

const acknowledgeItem = (c: Db, source: string, dedupKey: string, { now = Date.now(), patch }: MoveOptions = {}) =>
	moveItem(
		c,
		{ source, dedupKey, now, patch },
		{
			sql: "UPDATE items SET state = 'acknowledged', last_seen = ?, payload = ? WHERE id = ?",
			due: (state) => state === "triggered",
		},
	);

function patchItem(c: Db, source: string, dedupKey: string, patch: Record<string, unknown>): Item | undefined {
	return changeItem(c, source, dedupKey, (r) => {
		c.run("UPDATE items SET payload = ? WHERE id = ?", patchedPayload(r, patch), r.id);
	});
}

function resolveAbsentItems(
	c: Db,
	{ source, kind }: { source: string; kind: string },
	present: Iterable<string>,
	now = Date.now(),
): Item[] {
	const keep = new Set(present);
	return c.tx(() =>
		c
			.all("SELECT * FROM items WHERE source = ? AND kind = ? AND state != 'resolved'", source, kind)
			.filter((r) => !keep.has(r.dedup_key as string))
			.map((r) => {
				c.run("UPDATE items SET state = 'resolved', resolved_at = ? WHERE id = ?", now, r.id);
				return currentItem(c, source, r.dedup_key as string);
			}),
	);
}

function pruneItems(c: Db, before: number, keepSources = ["queue"]): number {
	const marks = keepSources.map(() => "?").join(",");
	return c.run(
		`DELETE FROM items WHERE state = 'resolved' AND last_seen < ? ${keepSources.length ? `AND source NOT IN (${marks})` : ""}`,
		before,
		...keepSources,
	).changes;
}

export const makeItems = (c: Db): Store["items"] => ({
	observe: (o) => observeItem(c, o),
	get: (source, dedupKey) => {
		const r = itemRow(c, source, dedupKey);
		return r ? toItem(r) : undefined;
	},
	list: (f) => listItems(c, f),
	resolve: (source, dedupKey, now, patch) => resolveItem(c, source, dedupKey, { now, patch }),
	acknowledge: (source, dedupKey, now, patch) => acknowledgeItem(c, source, dedupKey, { now, patch }),
	patch: (source, dedupKey, patch) => patchItem(c, source, dedupKey, patch),
	resolveAbsent: (source, kind, present, now) => resolveAbsentItems(c, { source, kind }, present, now),
	prune: (before, keepSources) => pruneItems(c, before, keepSources),
});

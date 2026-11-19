/** The rights a wake needs ahead of it: finding the prerequisite wake, queueing it, and sending it first. */
import { crashPoint } from "../crash.ts";
import { alarms, rightsInlineHead, rightsStaleNote, rightsUndeliveredNotice, rightsUnreadNotice } from "../messages.ts";
import { loadRightsSent, rightsFirstId, rightsFirstKey, rightsGap, rightsStateKey } from "../steward/rights-sent.ts";
import { exceedsEncodedCap } from "../steward/steward-types.ts";
import type { Store } from "../store/store.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { readRightsNow } from "./relay-compose.ts";
import { type Ctx, type InlineRights, type Lane, type RelayDeps, type RightsNow, raise } from "./relay-ctx.ts";

/**
 * `rightsInline`: what a Steward row that depends on the rights carries in its own POST. Nothing (undefined) when the durable record shows the
 * Steward holds the rights in force; the full block (and its stamp) when it does not, with the reason logged (`rights-inlined`); a short notice
 * (`unreadableRights`) when the rights cannot be read now. No standalone wake is queued, so no Steward turn is spent receiving text.
 */
export async function inlineRights(
	r: Ctx,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
	{ steward, gaps }: { steward: string | undefined; gaps: boolean },
): Promise<InlineRights | undefined> {
	const now = await readRightsNow(r, row, () => rightsNow(steward ? { steward } : undefined));
	if (!now) return unreadableRights(r, row);
	const record = loadRightsSent(r.store);
	const stale = staleFull(row, now);
	const reason = stale ?? (gaps ? rightsGap(record, now) : undefined);
	if (!reason) return undefined;
	const w = now.wake(row.deliveryId);
	r.d.log("rights-inlined", { deliveryId: row.deliveryId, reason });
	return {
		text: w.text ?? w.message,
		...(w.stamp ? { stamp: w.stamp } : {}),
		...(stale ? { stale: true as const } : {}),
	};
}

/**
 * The rights could not be read (the read threw): the row still goes, with a short notice, because a principal-facing row must never be held
 * back on this. The next row reads them again; the alarm is raised, and logged once per row.
 */
export function unreadableRights(r: Ctx, row: OutboxRow): InlineRights {
	if (!r.reported.has(`rights-unreadable:${row.deliveryId}`)) {
		r.reported.add(`rights-unreadable:${row.deliveryId}`);
		r.d.log("rights-unreadable", { deliveryId: row.deliveryId });
		raise(r, "rights-unreadable", alarms.rightsUnreadable());
	}
	return { text: rightsUnreadNotice, unreadable: true };
}

/**
 * The wake that carries the current rights was DEAD-LETTERED: it will not be sent again by itself, and the row that waited on it must not wait for
 * ever (an answer, a hand-off). It goes with a notice instead, the alarm is raised, and the next row has a prerequisite of its own, so the rights
 * are tried again with it.
 */
export function undeliveredRights(r: Ctx, row: OutboxRow): InlineRights {
	if (!r.reported.has(`rights-undelivered:${row.deliveryId}`)) {
		r.reported.add(`rights-undelivered:${row.deliveryId}`);
		r.d.log("rights-undelivered", { deliveryId: row.deliveryId });
		raise(r, "rights-undelivered", alarms.rightsUndelivered());
	}
	return { text: rightsUndeliveredNotice, undelivered: true };
}

/** Pure: the notice a rights-less row carries, whichever way the rights failed to come. */
const noticeOf = (i: InlineRights) => (i.undelivered ? rightsUndeliveredNotice : rightsUnreadNotice);

/** Pure: whether the notice fits in the same POST as the row. It must always reach the Steward: when it does not fit it goes first, on its own (`noticeAlone`). */
export function noticeFits(row: OutboxRow, inline: InlineRights): boolean {
	const line = DELIVERY_ID_LINE(row.deliveryId);
	return !exceedsEncodedCap(
		`${row.message.replace(line, "").trimEnd()}\n\n${noticeOf(inline)}\n${line}`,
		row.deliveryId,
	);
}

/**
 * The notice as a tiny wake of its own, POSTed just before a row that is too large to carry it. It is not an outbox row (nothing to retry or
 * dedupe: a repeat is harmless), and under an id derived from the row's. False when it was not accepted: the row then waits for the next pass,
 * since it must never go without either the rights or the notice.
 */
export async function noticeAlone(
	r: Ctx,
	row: OutboxRow,
	inline: InlineRights,
	{ l, target }: { l: Lane; target: string | undefined },
): Promise<boolean> {
	const res = await r.post(l, { ...row, deliveryId: `${row.deliveryId}:rights-notice` }, target, noticeOf(inline));
	if (!res.ok)
		r.d.log("rights-notice-failed", {
			deliveryId: row.deliveryId,
			...(res.status !== undefined ? { http: res.status } : {}),
		});
	return res.ok;
}

/**
 * Pure: a row that holds a FULL block was composed under the rights of its time. When the rights or rulings in force now are not the ones it was
 * stamped with (they changed, or were revoked, or cannot be read), delivering it would post old authorization as current and record the old hash.
 * Its text is never edited: the current rights ride after it and replace it, and the record is written from the current stamp (or not at all).
 */
function staleFull(row: OutboxRow, now: RightsNow): string | undefined {
	const old = row.rights?.some((s) => s.full && (now.hash === undefined || s.hash !== now.hash));
	return old
		? "the full rights this row carries are not the ones in force now (they changed, or cannot be read)"
		: undefined;
}

/** The text a row is POSTed with when the full rights ride in it: its own text exactly as queued, then the block under its heading, the delivery-id line last. */
export function withInlineRights(row: OutboxRow, inline: InlineRights): string {
	const line = DELIVERY_ID_LINE(row.deliveryId);
	const body = row.message.replace(line, "").trimEnd();
	if (inline.text && !inline.unreadable && !inline.undelivered)
		return `${body}\n\n${rightsInlineHead}\n${inline.text}\n${line}`;
	// The row goes as queued when its notice already went in a wake of its own.
	if (inline.sentAlone) return `${body}\n${line}`;
	// No block rides inside: the rights could not be read or delivered, or the current ones went as a wake of their own before this stale one.
	// The row goes with the notice (callers check `noticeFits` first; the stale one is best effort).
	const noted = `${body}\n\n${inline.unreadable || inline.undelivered ? noticeOf(inline) : rightsStaleNote}\n${line}`;
	return exceedsEncodedCap(noted, row.deliveryId) ? `${body}\n${line}` : noted;
}

/** The ids `:1`, `:2`, ... of the prerequisite for a state, where each stands: delivered, cancelled, or not ended (or unknown). */
function prerequisiteStatus(store: Store, id: string): string | undefined {
	const row = store.wakes.find(id);
	if (row) return row.status;
	if (!store.wakes.known(id)) return undefined;
	return store.wakes.isDelivered(id) ? "delivered" : "cancelled";
}

/**
 * The prerequisite for this state: the first of `:1`, `:2`, ... that has not ended. One that ended delivered without the record showing
 * it now (a compaction cleared it), or that the operator cancelled, gives way to the next. Undefined (and logged) after fifty.
 */
export function findPrerequisite(r: Ctx, row: OutboxRow, key: string): { id: string; delivered: boolean } | undefined {
	let delivered = false;
	for (let n = 1; ; n++) {
		if (n > 50) {
			r.d.log("rights-first-error", {
				deliveryId: row.deliveryId,
				error: "50 prerequisites for one state have ended without the record showing it",
			});
			return undefined;
		}
		const id = rightsFirstId(row.deliveryId, key, n);
		const status = prerequisiteStatus(r.store, id);
		if (status === "delivered") {
			delivered = true;
			continue;
		}
		if (status !== "cancelled") return { id, delivered };
	}
}

/** Writes the prerequisite for a row, and only while the row still waits; the row itself is left exactly as it is. Undefined (and logged) when it cannot be queued. */
export function queuePrerequisite(
	r: Ctx,
	row: OutboxRow,
	now: RightsNow,
	{ id, reason }: { id: string; reason: string },
): OutboxRow | undefined {
	const { d, store } = r;
	const t = r.clock();
	let done: boolean;
	try {
		done = store.tx(() => {
			// The row is left exactly as it is; only the prerequisite is written, and only while the row still waits.
			if (store.wakes.find(row.deliveryId)?.status !== "pending") return false;
			const w = now.wake(row.deliveryId);
			if (
				!store.wakes.enqueue({
					deliveryId: id,
					message: w.message,
					queuedAt: t,
					kind: "rights",
					...(w.stamp ? { rights: [w.stamp] } : {}),
				})
			)
				throw Error(`the rights-first wake's delivery id ${id} is already known`);
			return true;
		});
	} catch (e) {
		d.log("rights-first-error", { deliveryId: row.deliveryId, first: id, error: String(e).slice(0, 200) });
		return undefined;
	}
	if (!done) {
		d.log("rights-first-skipped", { deliveryId: row.deliveryId, first: id, reason });
		return undefined;
	}
	crashPoint("rights-first-queued");
	d.log("rights-first", { deliveryId: row.deliveryId, first: id, reason });
	return store.wakes.find(id);
}

/** Whether the prerequisite cannot go now (not pending, owed, or backing off); the first time a row waits on it, the wait is logged. */
export function prerequisiteBlocked(r: Ctx, row: OutboxRow, first: OutboxRow, id: string): boolean {
	if (first.status === "pending" && !r.owed.has(first.id) && (r.notBefore.get(first.id) ?? -Infinity) <= r.clock())
		return false;
	if (!r.waitingOn.has(row.deliveryId)) {
		r.waitingOn.add(row.deliveryId);
		r.d.log("rights-first-waiting", { deliveryId: row.deliveryId, first: id, status: first.status });
	}
	return true;
}

/**
 * A prerequisite sent on its own (its row went, was cancelled, or is behind it in the pass) only while it is still for the state there is now:
 * one for an older state would put older rights after newer ones, so it is cancelled instead (`rights-first-obsolete`). True: send it.
 */
export async function current(
	r: Ctx,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
): Promise<boolean> {
	const { d, store } = r;
	if (store.wakes.find(row.deliveryId)?.status !== "pending") return false;
	const now = await readRightsNow(r, row, rightsNow);
	if (!now) return false;
	if (rightsFirstKey(row.deliveryId) === rightsStateKey(now)) return true;
	if (store.wakes.cancel(row.deliveryId, r.clock()) === "pending")
		d.log("rights-first-obsolete", { deliveryId: row.deliveryId });
	return false;
}

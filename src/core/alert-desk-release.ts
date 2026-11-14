/** What the desk does with one event: the daily cap, the family's window, folding a repeat, and queueing the wake. */

import type { Pass } from "./alert-desk.ts";
import { ALERT_DESK, DAY_MS, DESK_KIND, DESK_RECEIVER, type DeskEvent } from "./alert-desk-config.ts";
import { alertMessage, clip, type Reason, signature, wakeId } from "./alert-desk-events.ts";
import type { WakeDraft } from "./deliver.ts";
import { repeatEvery } from "./notification.ts";

const windowKey = (family: string) => `${family}#window`;
const pendingKey = (family: string) => `${family}#pending`;
export type PendingPayload = {
	event: DeskEvent;
	sig: string /** `repeat`: the 24 h repeat already notified, so it goes without resolving the item. */;
	reason?: Reason;
};

/** Alert wakes of the rolling 24 h: the desk's own outbox rows and held wakes. Morning and cap notes are not alerts and do not count. */
function capFull(c: Pass): boolean {
	if (c.cfg.dailyCap <= 0) return false;
	const members = [
		...c.store.wakes.rows("all", DESK_RECEIVER).flatMap((row) => row.members),
		...c.store.wakes.held(DESK_RECEIVER),
	];
	return (
		members.filter((m) => m.deliveryId.startsWith("desk:") && c.now - m.queuedAt < DAY_MS).length >= c.cfg.dailyCap
	);
}

/** One event being released: the event, its signature, and the time it counts at. */
type Occurrence = { e: DeskEvent; sig: string; at: number };

const parkPending = (c: Pass, { e, sig, at }: Occurrence, reason: Reason) =>
	c.store.items.observe({
		source: ALERT_DESK,
		kind: "pending",
		dedupKey: pendingKey(e.family),
		mode: "silenced",
		payload: { event: e, sig, reason } satisfies PendingPayload,
		now: at,
	});

function dropPending(c: Pass, family: string, at: number, opts: { keepRepeat?: boolean } = {}) {
	const p = c.store.items.get(ALERT_DESK, pendingKey(family));
	if (p?.status !== "triggered") return;
	// A change that was undone is cancelled; a 24 h repeat the cap held back is not a change and stays until it is delivered.
	if (opts.keepRepeat && (p.payload as PendingPayload).reason === "repeat") return;
	c.store.items.resolve(ALERT_DESK, pendingKey(family), at);
}

function absorb(c: Pass, family: string, at: number) {
	const a = c.store.items.get(ALERT_DESK, family);
	if (a) c.store.items.patch(ALERT_DESK, family, { absorbed: Number(a.payload.absorbed ?? 0) + 1, lastEventAt: at });
}

/** Queues the wake for an event the gates let through, with every item change, in one transaction. `consumed`: the 24 h repeat already notified. */
function emit(c: Pass, { e, sig, at }: Occurrence, reason: Reason, consumed: boolean): void {
	const { store, cfg } = c;
	const out = c.outbox.commit((): WakeDraft | undefined => {
		const before = store.items.get(ALERT_DESK, e.family);
		const absorbed = Number(before?.payload.absorbed ?? 0);
		const wakes = Number(before?.payload.wakes ?? 0) + 1;
		const payload = {
			sig,
			title: clip(e.title, 140),
			severity: e.severity,
			source: e.source,
			absorbed: 0,
			wakes,
			lastEventAt: at,
		};
		if (consumed) store.items.patch(ALERT_DESK, e.family, payload);
		else {
			// A change is a new occurrence: resolve the open item so the next observation reopens it and notifies.
			if (before && before.status !== "resolved") store.items.resolve(ALERT_DESK, e.family, at);
			const o = store.items.observe({
				source: ALERT_DESK,
				kind: "alert",
				dedupKey: e.family,
				repeat: repeatEvery(cfg.repeatMs),
				payload,
				now: at,
			});
			if (!o.notify) return undefined;
		}
		dropPending(c, e.family, at);
		const id = wakeId(e.family, sig, e.ts);
		return {
			deliveryId: id,
			message: alertMessage(e, reason, absorbed, Math.round(cfg.windowMs / 60_000)),
			meta: { kind: DESK_KIND, receiver: DESK_RECEIVER },
		};
	});
	if (out === "queued") c.woke.push(`${e.family}:${reason}`);
}

/** The gates a wake-worthy event passes: the daily cap, then the family's window. Returns whether it was emitted. */
function release(c: Pass, occ: Occurrence, reason: Reason, consumed: boolean): boolean {
	const { e, at } = occ;
	const { store, cfg } = c;
	if (capFull(c)) {
		c.deferred.add(e.family);
		store.tx(() => parkPending(c, occ, reason));
		return false;
	}
	const gate = store.items.observe({
		source: ALERT_DESK,
		kind: "window",
		dedupKey: windowKey(e.family),
		repeat: repeatEvery(cfg.windowMs),
		now: at,
	});
	if (!gate.notify) {
		store.tx(() => {
			parkPending(c, occ, reason);
			absorb(c, e.family, at);
		});
		return false;
	}
	emit(c, occ, reason, consumed);
	return true;
}

/** The same alert again. The item's own 24 h repeat says whether it is a recurrence; otherwise it is folded, and a change that was
 * waiting for its window is cancelled (the alert is back to what the desk was last told). */
function repeatOrFold(c: Pass, e: DeskEvent, sig: string, at: number): void {
	const o = c.store.items.observe({
		source: ALERT_DESK,
		kind: "alert",
		dedupKey: e.family,
		repeat: repeatEvery(c.cfg.repeatMs),
		now: at,
	});
	if (o.notify) {
		if (!release(c, { e, sig, at }, "repeat", true)) {
			/* parked */
		}
	} else {
		absorb(c, e.family, at);
		dropPending(c, e.family, at, { keepRepeat: true });
	}
}

/** One event through the item system: a new alert, a changed one, or the same one again. */
export function decide(c: Pass, e: DeskEvent): void {
	const at = Math.min(c.now, Date.parse(e.ts));
	const sig = signature(e);
	const a = c.store.items.get(ALERT_DESK, e.family);
	if (!a || a.status === "resolved") {
		release(c, { e, sig, at }, "new", false);
		return;
	}
	if (a.payload.sig !== sig) {
		release(c, { e, sig, at }, "changed", false);
		return;
	}
	c.store.tx(() => repeatOrFold(c, e, sig, at));
}

/** A change that waited for its window to close, or a wake the cap deferred. */
export function releasePending(c: Pass): void {
	for (const p of c.store.items.list({ source: ALERT_DESK, kind: "pending", status: "triggered" })) {
		const { event, sig, reason } = p.payload as PendingPayload;
		const a = c.store.items.get(ALERT_DESK, event.family);
		const open = a !== undefined && a.status !== "resolved";
		// A change that was undone before its window closed is cancelled; a parked 24 h repeat is not a change and still goes.
		if (reason !== "repeat" && open && a.payload.sig === sig) {
			c.store.items.resolve(ALERT_DESK, p.dedupKey, c.now);
			continue;
		}
		release(
			c,
			{ e: event, sig, at: c.now },
			reason === "repeat" ? "repeat" : open ? "changed" : "new",
			reason === "repeat",
		);
	}
}

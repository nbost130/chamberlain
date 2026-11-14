/**
 * The Alert Desk: alerts get their own standing thread (the desk) instead of a Steward wake kind.
 *
 * Alert sources append one JSON line each to an inbox file (default ~/.cache/alert-desk/inbox.jsonl; CHAMBERLAIN does not care who
 * writes it). This module drains the file and decides, per alert FAMILY, whether the desk is woken. It is backend-agnostic: it reads
 * a file, uses the item system for every decision about what notifies, and hands wake text to the outbox for the `desk` receiver. The
 * one relay (core/relay.ts, the `desk` lane of `receivers`) sends it through the adapter's `alertDesk` capability, with the desk thread's own
 * gate, so the hold-and-digest path folds a burst of families into one wake and a busy desk never holds the Steward's wakes.
 *
 * The inbox line (one object per line, one O_APPEND write per line):
 *   { v:1, source, family, title, body, ts (ISO), severity: "critical" | "warning" | "info" }
 *
 * Dedupe, per family. ONE item system decides (notification.ts): there is no second record of what already woke the desk.
 *   - an item of kind `alert`, keyed by the family, repeats every `repeatMs` (24 h): an unchanged alert re-notifies once a day;
 *   - a CHANGE (a different severity, title or opening of the body, with timestamps and numbers blanked: `signature`) resolves the item,
 *     so the next observation is a new occurrence that notifies at once;
 *   - an item of kind `window`, keyed by the family, repeats every `windowMs` (15 min): it is the gate. A wake only goes when the gate
 *     notifies, so at most one wake per family per window;
 *   - what the gate or the cap holds back is kept as an item of kind `pending` in mode `silenced` (tracked, never notifies) and goes on
 *     a later pass, so nothing is dropped. A change that is undone before then cancels itself;
 *   - the daily cap (`dailyCap` alert wakes per rolling 24 h, 0 = no cap) is counted from the desk's own outbox rows and held wakes; the
 *     desk is told once a day (an item of kind `cap-note`, repeating every 24 h).
 * The first pass of each local day from `morningHour` also sends the morning wake: an item of kind `morning`, keyed by the date and
 * notified once. The desk then runs the Morning sweep of its standing prompt (docs/alert-desk-prompt.md), over the operator's own
 * morning sources (`morningCommands` in alert-desk.json; `renderDeskPrompt` fills them in, and src/desk-allowlist.ts allows exactly them).
 */
import { unlinkSync } from "node:fs";
import { ALERT_DESK, DAY_MS, DESK_KIND, DESK_RECEIVER, type DeskConfig, readConfig } from "./alert-desk-config.ts";
import {
	type CrashPoint,
	CURSOR_KEY,
	type Cursor,
	firstCursor,
	type Retired,
	readInbox,
	recoverRotation,
	rotateIfDue,
	sweepStrays,
} from "./alert-desk-cursor.ts";
import { capMessage, localDay, morningMessage } from "./alert-desk-events.ts";
import { decide, type PendingPayload, releasePending } from "./alert-desk-release.ts";
import type { Outbox } from "./deliver.ts";
import { NOTIFY_ONCE, repeatEvery } from "./notification.ts";
import type { Item, Store } from "./store.ts";

/** Items of a family no one has reported for this long are resolved, so a later event is a new occurrence and retention can prune them. */
const FORGET_MS = 3 * DAY_MS;

export type DrainDeps = {
	store: Store;
	outbox: Outbox;
	inbox: string;
	conf: string;
	now: number;
	/** False while the desk has nowhere to send (no desk URL): nothing is read, so nothing is lost. */
	canDeliver: boolean;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Tests: called at each step a crash could land on. A throw there is the crash. */
	crash?: (point: CrashPoint) => void;
};

/** What one pass works on: the stores, the clock, the config, and the wakes it has queued and the families the daily cap held back so far. */
export type Pass = {
	store: Store;
	outbox: Outbox;
	now: number;
	cfg: DeskConfig;
	woke: string[];
	deferred: Set<string>;
};

/** Once a day, if the cap held anything back, the desk is told so. */
function noteCap(c: Pass): void {
	if (!c.deferred.size) return;
	c.outbox.commit(() => {
		if (
			!c.store.items.observe({
				source: ALERT_DESK,
				kind: "cap-note",
				dedupKey: "cap",
				repeat: repeatEvery(DAY_MS),
				now: c.now,
			}).notify
		)
			return undefined;
		c.woke.push("cap");
		return {
			deliveryId: `desk-cap:${Math.floor(c.now / DAY_MS)}`,
			message: capMessage(c.cfg, [...c.deferred]),
			meta: { kind: DESK_KIND, receiver: DESK_RECEIVER },
		};
	});
}

/** The first pass of each local day from the morning hour sends the morning wake. */
function sendMorning(c: Pass): void {
	const { store, now } = c;
	const { day, hour } = localDay(now, c.cfg.timezone);
	if (hour < c.cfg.morningHour) return;
	c.outbox.commit(() => {
		if (!store.items.observe({ source: ALERT_DESK, kind: "morning", dedupKey: day, repeat: NOTIFY_ONCE, now }).notify)
			return undefined;
		const live = (i: Item) =>
			now - Number(i.payload.lastEventAt ?? i.lastSeen) < DAY_MS && Number(i.payload.wakes ?? 0) > 0;
		const handled = store.items
			.list({ source: ALERT_DESK, kind: "alert" })
			.filter(live)
			.map((i) => ({
				family: i.dedupKey,
				wakes: Number(i.payload.wakes),
				severity: String(i.payload.severity),
				title: String(i.payload.title),
			}));
		const waiting = store.items
			.list({ source: ALERT_DESK, kind: "pending", status: "triggered" })
			.map((i) => (i.payload as PendingPayload).event.family);
		c.woke.push("morning");
		return {
			deliveryId: `desk-morning:${day}`,
			message: morningMessage(day, handled, waiting),
			meta: { kind: DESK_KIND, receiver: DESK_RECEIVER },
		};
	});
}

/** Families nobody has reported for three days are resolved: a later event is a new occurrence. */
function forgetQuietFamilies(c: Pass): void {
	const { store, now } = c;
	store.tx(() => {
		for (const i of store.items.list({ source: ALERT_DESK, kind: "alert", status: "triggered" }))
			if (now - Number(i.payload.lastEventAt ?? i.lastSeen) > FORGET_MS)
				store.items.resolve(ALERT_DESK, i.dedupKey, now);
		for (const i of store.items.list({ source: ALERT_DESK, kind: "window", status: "triggered" }))
			if (now - i.lastSeen > FORGET_MS) store.items.resolve(ALERT_DESK, i.dedupKey, now);
	});
}

/** The stored cursor, or the first one (kept before anything is read, so a crash later in the pass never decides it again). */
function openCursor(d: DrainDeps, cfg: DeskConfig): { cur: Cursor; save: () => void } {
	const stored = d.store.state.get<Cursor>(CURSOR_KEY);
	const cur = structuredClone(stored ?? firstCursor(d.inbox, cfg.startAt));
	const save = () => d.store.state.set(CURSOR_KEY, cur);
	if (!stored) {
		save();
		d.log("alert-desk-start", {
			startAt: cfg.startAt,
			inbox: d.inbox,
			offset: cur.offset,
			...(cfg.startAt === "end" && cur.offset ? { skippedBytes: cur.offset } : {}),
		});
	}
	return { cur, save };
}

/** After the wakes are queued and the cursor is saved: the retired files that were read to their end are deleted. */
function deleteRetired(read: Retired[]): void {
	for (const x of read) {
		try {
			unlinkSync(x.path);
		} catch {
			/* already gone */
		}
	}
}

/** One pass: read what is new, decide each event through the item system, queue the wakes, then (and only then) keep the cursor. */
export function drainAlertDesk(d: DrainDeps): { read: number; woke: number; skipped?: "off" | "no-desk" } {
	const { store, outbox, now } = d;
	const cfg = readConfig(d.conf);
	if (!cfg.enabled) return { read: 0, woke: 0, skipped: "off" };
	if (!d.canDeliver) return { read: 0, woke: 0, skipped: "no-desk" };
	const crash = d.crash ?? (() => {});
	const { cur, save } = openCursor(d, cfg);
	if (recoverRotation(cur, now)) save();
	rotateIfDue(cur, { inbox: d.inbox, now, cfg }, { save, crash });
	sweepStrays(cur, d.inbox, now);
	const r = readInbox(cur, d.inbox, now, cfg);
	const c: Pass = { store, outbox, now, cfg, woke: [], deferred: new Set() };

	for (const e of r.events) decide(c, e);
	releasePending(c);
	noteCap(c);
	sendMorning(c);
	forgetQuietFamilies(c);
	crash("delivered");
	if (r.retiredRead.length) crash("retired-read");
	cur.retired = cur.retired.filter((x) => !r.retiredRead.includes(x));
	save();
	if (r.retiredRead.length) crash("retired-saved");
	deleteRetired(r.retiredRead);
	if (r.events.length || r.bad || r.stale || c.woke.length)
		d.log("alert-desk", {
			events: r.events.length,
			bad: r.bad,
			stale: r.stale,
			woke: c.woke,
			deferred: c.deferred.size,
		});
	return { read: r.events.length, woke: c.woke.length };
}

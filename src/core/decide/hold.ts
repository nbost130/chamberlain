/**
 * One wake at a time into the Steward's thread, for the wakes that can wait (HOLDABLE_KINDS). While the Steward is working, or already
 * has a queued turn, such a wake is held (table `held_wakes`) instead of becoming an outbox row of its own. When the relay finds the
 * Steward idle, or the ceiling is reached, it composes everything held into ONE outbox row in one transaction: a digest that keeps each
 * item's text and delivery id, with every held item bound to it for good (store.ts, `compose`).
 *
 * What this file owns is the pure part: which wake to send (composeWake) and whether it may go now (observe). Holding, composing and
 * sending are relay.ts's.
 */
import { createHash } from "node:crypto";
import { digestHead } from "../messages.ts";
import type { HeldItem, HoldClock, WakeMeta } from "../store/store-wakes.ts";

export type { HeldItem, HoldClock, WakeMeta };

/** What the Steward's thread is doing. Unknown (an unreadable source) holds like busy: the ceiling still lets a wake out. */
export type Gate = "idle" | "busy" | "unknown";
/**
 * The only wakes that may wait for their thread to go idle: a thread finishing a turn, the routine sweep, the Alert Desk's alerts (which
 * wait on the desk's own gate, never held behind the Steward), a decision-queue answer, and a thread's note (note.ts). Everything else (a
 * question or approval, a failure, any kind not named here) goes out at once: a thread waiting on the Steward is blocked until it does.
 */
const HOLDABLE_KINDS: ReadonlySet<string> = new Set(["turn_ended", "sweep", "alert_desk", "answer", "note"]);
export const holdable = (meta: WakeMeta | undefined): boolean => Boolean(meta && HOLDABLE_KINDS.has(meta.kind));
/**
 * Kinds that are never folded: each answer settles its own item and each note is its own report, so a later one about the same thread
 * never replaces an earlier one. (Folding six answers about one thread into the latest would drop five of the principal's choices.)
 */
const NEVER_FOLDED: ReadonlySet<string> = new Set(["answer", "note"]);

/**
 * The held kinds that are news, not a request: a thread's turn end, its note, a routine sweep. None has a person waiting on it, so when the Steward is idle
 * they wait `debounceMs` for company (`debouncing`) and go as one digest, one Steward turn instead of several. An answer (the principal is waiting),
 * a transfer (a switch is in progress) or any wake of another kind held beside them sends the whole batch at once; a wake that is not holdable at all
 * (needs_input, a failure, a message) is never held and never waits.
 */
const DEBOUNCED_KINDS: ReadonlySet<string> = new Set(["turn_ended", "note", "sweep"]);
/** How long the daemon lets idle news wait for company (`wakeDebounceMs`; 0 turns it off). */
export const DEFAULT_WAKE_DEBOUNCE_MS = 3 * 60_000;

/** A give-up row's id, from its members: two batches never share one, whatever the clock does. */
export const memberHash = (ids: readonly string[]) =>
	createHash("sha1")
		.update([...ids].sort().join("\n"))
		.digest("hex")
		.slice(0, 16);

/** A Steward busy this long gets the digest anyway, and never more than one such digest per window. */
export const HOLD_CEILING_MS = 20 * 60_000;
/**
 * Kinds with a shorter ceiling of their own, counted from when the item was held: the principal is waiting on an answer, so a busy Steward
 * gets the held answers (and whatever is held beside them) this long after the oldest one, not after the full ceiling.
 */
const ITEM_CEILING_MS: Readonly<Record<string, number>> = { answer: 3 * 60_000 };
/** A held item stamped further than this in the future was stamped by a clock that has since gone back: it is treated as overdue. */
const CLOCK_SKEW_MS = 60_000;
/**
 * Pure: does a held item of a kind with its own ceiling (an answer) have to go now, busy Steward or not? An item from the future (the page's
 * clock ahead of the relay's, or the clock set back since) goes too, so no clock correction can hold an answer past its ceiling.
 */
export const overdue = (held: readonly HeldItem[], now: number): boolean =>
	held.some((h) => {
		const ceiling = h.kind ? ITEM_CEILING_MS[h.kind] : undefined;
		const age = now - h.queuedAt;
		return ceiling !== undefined && (age >= ceiling || age < -CLOCK_SKEW_MS);
	});
/**
 * Pure: should these held wakes keep waiting for company? Only when every one is news (`DEBOUNCED_KINDS`) and the oldest is younger than
 * `debounceMs`. So the wait is at most `debounceMs` from the first of them, whatever arrives after. Never for an empty or mixed batch,
 * and an item stamped in the future (a clock set back) does not wait.
 */
export const debouncing = (held: readonly HeldItem[], now: number, debounceMs: number): boolean => {
	if (!(debounceMs > 0) || !held.length) return false;
	if (!held.every((h) => h.kind !== undefined && DEBOUNCED_KINDS.has(h.kind))) return false;
	const age = now - Math.min(...held.map((h) => h.queuedAt));
	return age >= -CLOCK_SKEW_MS && age < debounceMs;
};
/** Pure: whether a held item has a ceiling of its own, so it is admitted to a size-capped digest ahead of the rest. */
export const hasOwnCeiling = (h: HeldItem): boolean => h.kind !== undefined && ITEM_CEILING_MS[h.kind] !== undefined;
/** T3 takes a moment to show a wake it just accepted as a queued turn. Until it does, a fresh post counts as busy. */
const POST_GRACE_MS = 30_000;
/** The relay looks at least once a minute. A gap longer than this means the stretch was not watched. */
const OBSERVE_GAP_MS = 5 * 60_000;

/**
 * Pure: the wake that carries these items. One item goes as itself, under its own ID. Several go as one digest under an
 * ID made from the items' own, so the same set always has the same ID. Of the items that share a thread and a kind only
 * the latest is kept; the rest are folded into it and counted. Every item, folded or not, is a member: it is delivered with
 * the wake and is never sent again.
 */
/**
 * What the engine last saw of a thread from T3: whether its server is connected, the thread's newest run, its status, and whether it is
 * settled or archived. Absent fields are unknown.
 */
export type ThreadNews = {
	connected: boolean;
	latestRunId?: string | null;
	status?: string;
	settled?: boolean;
	archived?: boolean;
};
/** `news`: the daemon's view of a thread at composition, for each turn-end item's freshness note. */
export type ComposeOpts = { news?: (thread: string) => ThreadNews | undefined };
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const WORKING = new Set(["running", "queued", "starting", "preparing", "waiting"]);

/**
 * The run a turn-end report is about: its id is `<thread>:ended:<run id>:<time>` (decide.ts endedKey, then the watcher's timestamp), and
 * a run id can itself hold colons (`run:thread:...:ordinal:8`). Undefined for a report that names no run (`<thread>:ended:<time>`).
 */
export function reportRunId(deliveryId: string): string | undefined {
	const m = /:ended:(.+)$/.exec(deliveryId);
	const run = m?.[1]?.replace(/:\d{12,}$/, "");
	return !run || /^\d{12,}$/.test(run) ? undefined : run;
}

/**
 * Pure: what a digest notes about a held turn-end report, from T3's state as the engine holds it: only facts that were observed, never
 * a claim that the report is still current (a reconnect shows "connected" before its catch-up arrives, so the engine's view can lag).
 * Each note is a reason to read the thread before acting; no note means nothing was observed, not that nothing happened. "" for other
 * kinds, or when nothing was observed.
 */
function freshness(i: HeldItem, now: number, o: ComposeOpts): string {
	if (i.kind !== "turn_ended" || !i.thread || !o.news) return "";
	const n = o.news(i.thread);
	const run = reportRunId(i.deliveryId);
	if (!n) return "";
	const at = hhmm(now);
	if (n.settled || n.archived) return ` · seen at ${at} UTC: its thread is ${n.settled ? "settled" : "archived"}`;
	if (run && typeof n.latestRunId === "string" && n.latestRunId && n.latestRunId !== run)
		return ` · seen at ${at} UTC: a newer run of its thread has started`;
	if (n.status && WORKING.has(n.status)) return ` · seen at ${at} UTC: its thread is working again`;
	return "";
}

export function composeWake(
	items: HeldItem[],
	now: number,
	o: ComposeOpts = {},
): { deliveryId: string; message: string; members: string[]; kept: string[]; folded: number } {
	const [only] = items;
	if (only && items.length === 1)
		return {
			deliveryId: only.deliveryId,
			message: only.message,
			members: [only.deliveryId],
			kept: [only.deliveryId],
			folded: 0,
		};
	const sorted = [...items].sort((a, b) => a.queuedAt - b.queuedAt);
	const latest = new Map<string, HeldItem>();
	/**
	 * Same thread + kind folds duplicates. A turn_ended key that names a completed run (issue #74) must not fold with
	 * another run's report: each completed run keeps its own final. Timestamp-only ended keys still fold as before.
	 */
	const key = (i: HeldItem) => {
		// Sweeps never fold: the findings sweep, the idle-thread list and even a full sweep carry what was new when each was made.
		if (i.kind === "sweep") return undefined;
		if (!i.kind || !i.thread || NEVER_FOLDED.has(i.kind)) return undefined;
		if (i.kind === "turn_ended") {
			// The whole run id: run ids hold colons, so cutting at the first one made every run-scoped report of a thread fold into one.
			const run = reportRunId(i.deliveryId);
			if (run) return `${i.kind}\u0000${i.thread}\u0000${run}`;
		}
		return `${i.kind}\u0000${i.thread}`;
	};
	for (const i of sorted) {
		const k = key(i);
		if (k) latest.set(k, i);
	}
	const folds = new Map<HeldItem, HeldItem[]>();
	const kept: HeldItem[] = [];
	for (const i of sorted) {
		const k = key(i);
		const keeper = (k ? latest.get(k) : undefined) ?? i;
		if (keeper === i) kept.push(i);
		else folds.set(keeper, [...(folds.get(keeper) ?? []), i]);
	}
	const folded = sorted.length - kept.length;
	const members = sorted.map((i) => i.deliveryId);
	const deliveryId = `digest:${createHash("sha1")
		.update([...members].sort().join("\n"))
		.digest("hex")
		.slice(0, 16)}`;
	const head = digestHead(sorted.length, folded);
	// Each item's text goes in exactly as it was queued: nothing in it is searched or replaced, a repeated rights block included (it costs
	// tokens, never correctness).
	const blocks = kept.map((i, n) => {
		const f = folds.get(i) ?? [];
		const waited = Math.max(0, Math.round((now - i.queuedAt) / 60_000));
		return [
			`=== item ${n + 1} of ${kept.length} · deliveryId: ${i.deliveryId} · held ${waited} min${freshness(i, now, o)}${f.length ? ` · folded ${f.length} earlier ${i.kind} wake${f.length === 1 ? "" : "s"} for this thread (${f.map((x) => x.deliveryId).join(", ")})` : ""} ===`,
			i.message,
		].join("\n");
	});
	return { deliveryId, message: [head, ...blocks].join("\n\n"), members, kept: kept.map((i) => i.deliveryId), folded };
}

/**
 * The look at the Steward, updating the stretch it has been busy. `post` is whether held items may go now: when it is
 * idle, or when it has been busy for the whole ceiling and no ceiling digest has gone in the last ceiling's time.
 * Mutates the state it is given; the caller saves it.
 */
export function observe(
	st: HoldClock,
	gate: Gate,
	now: number,
	ceilingMs = HOLD_CEILING_MS,
): { post: boolean; forced: boolean } {
	if (st.seenAt === undefined || now - st.seenAt > OBSERVE_GAP_MS) st.busySince = undefined;
	st.seenAt = now;
	const busy = gate !== "idle" || (st.lastPostAt !== undefined && now - st.lastPostAt < POST_GRACE_MS);
	if (!busy) {
		st.busySince = undefined;
		return { post: true, forced: false };
	}
	st.busySince ??= now;
	const forced = now - st.busySince >= ceilingMs && now - (st.lastForcedAt ?? -Infinity) >= ceilingMs;
	return { post: forced, forced };
}

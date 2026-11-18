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
import { digestHead, fullSweepHead } from "../messages.ts";
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
 * What T3 says about a thread now, from the daemon's live view of it: whether that view is current (its server connected), the thread's
 * newest run, its status, and whether it is settled or archived. Absent fields are unknown.
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
 * Pure: what a digest says about a held turn-end report, stamped with the time it was checked. State, not timing: the report's run is
 * compared with the thread's newest run as T3 reports it now. It says the report is current only when the daemon's view is live, the
 * thread's newest run is the report's run and the thread is idle. "" for other kinds, or when there is no view at all.
 */
function freshness(i: HeldItem, now: number, o: ComposeOpts): string {
	if (i.kind !== "turn_ended" || !i.thread || !o.news) return "";
	const n = o.news(i.thread);
	const run = reportRunId(i.deliveryId);
	const at = hhmm(now);
	if (!n?.connected || !run || n.latestRunId === undefined)
		return " · not confirmed current: read the thread before acting";
	if (n.settled || n.archived)
		return ` · as of ${at} UTC its thread is ${n.settled ? "settled" : "archived"}: likely nothing to do`;
	if (n.latestRunId !== run)
		return ` · as of ${at} UTC a newer run of its thread has started: read the thread before acting`;
	if (n.status && WORKING.has(n.status)) return ` · as of ${at} UTC its thread is working again: read it before acting`;
	return ` · as of ${at} UTC this is still its thread's newest run, and the thread is idle`;
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
		// Only the full-sweep reminder repeats itself: the findings sweep and the idle-thread list carry only what is new since the last
		// one, so folding an older one into a newer one would lose items.
		if (i.kind === "sweep" && i.message.startsWith(fullSweepHead())) return "sweep\u0000full";
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

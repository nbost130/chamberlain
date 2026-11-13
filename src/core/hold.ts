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
import { RIGHTS_MARKER } from "./decide.ts";
import type { HeldItem, HoldClock, WakeMeta } from "./store.ts";

export type { HeldItem, HoldClock, WakeMeta };

/** What the Steward's thread is doing. Unknown (an unreadable source) holds like busy: the ceiling still lets a wake out. */
export type Gate = "idle" | "busy" | "unknown";
/**
 * The only wakes that may wait for the Steward to go idle: a thread finishing a turn, the routine sweep. Everything
 * else (a question or approval, a failure, a decision-queue answer, any kind not named here) goes out at once.
 */
export const HOLDABLE_KINDS: ReadonlySet<string> = new Set(["turn_ended", "sweep"]);
export const holdable = (meta: WakeMeta | undefined): boolean => Boolean(meta && HOLDABLE_KINDS.has(meta.kind));

/** A Steward busy this long gets the digest anyway, and never more than one such digest per window. */
export const HOLD_CEILING_MS = 20 * 60_000;
/** T3 takes a moment to show a wake it just accepted as a queued turn. Until it does, a fresh post counts as busy. */
export const POST_GRACE_MS = 30_000;
/** The relay looks at least once a minute. A gap longer than this means the stretch was not watched. */
export const OBSERVE_GAP_MS = 5 * 60_000;

/**
 * Pure: the wake that carries these items. One item goes as itself, under its own ID. Several go as one digest under an
 * ID made from the items' own, so the same set always has the same ID. Of the items that share a thread and a kind only
 * the latest is kept; the rest are folded into it and counted. Every item, folded or not, is a member: it is delivered with
 * the wake and is never sent again.
 */
export function composeWake(items: HeldItem[], now: number): { deliveryId: string; message: string; members: string[]; folded: number } {
	if (items.length === 1) return { deliveryId: items[0]!.deliveryId, message: items[0]!.message, members: [items[0]!.deliveryId], folded: 0 };
	const sorted = [...items].sort((a, b) => a.queuedAt - b.queuedAt);
	const latest = new Map<string, HeldItem>();
	const key = (i: HeldItem) => (i.kind && i.thread ? `${i.kind}\u0000${i.thread}` : undefined);
	for (const i of sorted) { const k = key(i); if (k) latest.set(k, i); }
	const folds = new Map<HeldItem, HeldItem[]>();
	const kept: HeldItem[] = [];
	for (const i of sorted) {
		const k = key(i);
		const keeper = k ? latest.get(k)! : i;
		if (keeper === i) kept.push(i);
		else folds.set(keeper, [...(folds.get(keeper) ?? []), i]);
	}
	const folded = sorted.length - kept.length;
	const members = sorted.map((i) => i.deliveryId);
	const deliveryId = `digest:${createHash("sha1").update([...members].sort().join("\n")).digest("hex").slice(0, 16)}`;
	const head = `[chamberlain] digest: ${sorted.length} wake${sorted.length === 1 ? "" : "s"} were held while you were busy and arrive together as this one wake, oldest first. Treat each item below as its own wake; each keeps its delivery ID, and if one reaches you twice the second is a repeat.${folded ? ` ${folded} earlier wake${folded === 1 ? "" : "s"} about the same thread and kind ${folded === 1 ? "was" : "were"} folded into the latest, which is all that is kept.` : ""}`;
	// Each held wake carries the decision rights (in full after a compaction). The digest keeps the first copy and
	// points later identical copies at it, so one wake never repeats the same rules block several times.
	const seenRights = new Set<string>();
	const blocks = kept.map((i, n) => {
		const f = folds.get(i) ?? [];
		const waited = Math.max(0, Math.round((now - i.queuedAt) / 60_000));
		return [
			`=== item ${n + 1} of ${kept.length} · deliveryId: ${i.deliveryId} · held ${waited} min${f.length ? ` · folded ${f.length} earlier ${i.kind} wake${f.length === 1 ? "" : "s"} for this thread (${f.map((x) => x.deliveryId).join(", ")})` : ""} ===`,
			dedupeRights(i.message, seenRights),
		].join("\n");
	});
	return { deliveryId, message: [head, ...blocks].join("\n\n"), members, folded };
}

/** The marker that starts the full rights block (rights-sent.ts). Everything from it to the message's end is rules + mandate. */
export { RIGHTS_MARKER };
export const RIGHTS_SEE_ABOVE = "Decision rights: the same as in the first item of this digest above, and still in force.";

/** Pure: the message with its rights tail replaced by a pointer when an identical tail was already shown in this digest. */
export function dedupeRights(message: string, shown: Set<string>): string {
	const at = message.indexOf(RIGHTS_MARKER);
	if (at < 0) return message;
	const tail = message.slice(at);
	if (!shown.has(tail)) { shown.add(tail); return message; }
	return message.slice(0, at) + RIGHTS_SEE_ABOVE;
}

/**
 * The look at the Steward, updating the stretch it has been busy. `post` is whether held items may go now: when it is
 * idle, or when it has been busy for the whole ceiling and no ceiling digest has gone in the last ceiling's time.
 * Mutates the state it is given; the caller saves it.
 */
export function observe(st: HoldClock, gate: Gate, now: number, ceilingMs = HOLD_CEILING_MS): { post: boolean; forced: boolean } {
	if (st.seenAt === undefined || now - st.seenAt > OBSERVE_GAP_MS) st.busySince = undefined;
	st.seenAt = now;
	const busy = gate !== "idle" || (st.lastPostAt !== undefined && now - st.lastPostAt < POST_GRACE_MS);
	if (!busy) { st.busySince = undefined; return { post: true, forced: false }; }
	st.busySince ??= now;
	const forced = now - st.busySince >= ceilingMs && now - (st.lastForcedAt ?? -Infinity) >= ceilingMs;
	return { post: forced, forced };
}

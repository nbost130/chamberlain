/**
 * Pure rules for a question card in a thread the principal is driving (`activeHold`): when the card waits for them instead of waking the Steward,
 * and what a held card is worth when its window ends. Reads no clock, no thread and no store: the caller hands in what it saw.
 */
import type { ThreadState } from "../adapter/adapter.ts";
import type { WaitingRead } from "../adapter/adapter-waiting.ts";
import type { Parked } from "../store/store-wakes.ts";

/**
 * When a card raised at `now` stops waiting: the principal's last message in the thread plus the window, or undefined when there is nothing to
 * wait for (no message seen, or the window has already ended). A last message stamped in the future (a clock set back) holds no longer than
 * one window from now.
 */
export function holdUntil(lastWriteAt: number | undefined, now: number, windowMs: number): number | undefined {
	if (lastWriteAt === undefined || !Number.isFinite(lastWriteAt) || !(windowMs > 0)) return undefined;
	const until = Math.min(lastWriteAt + windowMs, now + windowMs);
	return Number.isFinite(until) && until > now ? until : undefined;
}

/** What to do with a held card when its window ends: wake the Steward as an ordinary needs_input wake, or drop it, and why. */
export type Verdict = { act: "wake" } | { act: "drop"; reason: "answered" | "left" };

/**
 * Pure: the verdict on a held card, from the thread as the engine knows it now (`live`, undefined when it does not know it) and a fresh read
 * of what the thread waits on (`read`, undefined when none was made). A card is dropped only on positive evidence: its thread is archived,
 * settled or snoozed (`left`, T3's own record), or a successful read shows EVERY one of the card's requests with its own item in a terminal status
 * (`answered`, `WaitingRead.resolved`). A card merely missing from the read is not evidence: T3's snapshot is a bounded window of the thread's
 * history, so an unanswered card can be absent from it. Everything else (no read, a failed read, a card not seen either way, a thread the engine
 * cannot see) wakes the Steward. A wake raised with no card ids has no request to look for, so the thread's own status is the record.
 */
export function releaseVerdict(
	p: Pick<Parked, "requestIds">,
	live: ThreadState | undefined,
	read: WaitingRead | undefined,
): Verdict {
	if (!live) return { act: "wake" };
	if (live.archived || live.settled || live.snoozed) return { act: "drop", reason: "left" };
	if (!p.requestIds.length)
		return live.status === "waiting" || live.pendingRequestId ? { act: "wake" } : { act: "drop", reason: "answered" };
	if (read?.ok && p.requestIds.every((id) => read.resolved?.includes(id))) return { act: "drop", reason: "answered" };
	return { act: "wake" };
}

/** Pure: the wake's text with `note` as its second line, after the head line the Steward reads first. */
export function withNote(message: string, note: string): string {
	const i = message.indexOf("\n");
	return i < 0 ? `${message}\n${note}` : `${message.slice(0, i)}\n${note}${message.slice(i)}`;
}

/**
 * Snooze: a question the principal cannot act on now goes off the active list until a time they set, into the page's Snoozed
 * section. It is not answered, so nothing about it changes but where it shows: its item stays open, its claim is never made and
 * its afk hold stays open, with a note of when it returns.
 *
 * The time is the item's own (`snoozedUntil` in its payload) and the active list reads it against a clock (`questionStates`), so a
 * snoozed item is back on the list the moment its time passes, with no timer and nothing to run: a restart, or a daemon that is
 * down, changes nothing. The daemon's one extra job is the notice: `returnDueSnoozes` runs on its tick and hands back each returned
 * item once, so an urgent one can be shown where the operator reads again. A snooze ends four ways: its time passes, the principal
 * un-snoozes, an answer, direction or dismissal settles the item (the page clears it), or the card behind a pointer resolves.
 */
import type { Adapter, PostResult } from "./adapter.ts";
import { heldForItem, heldId, heldOpen, noteHeld } from "./afk-held.ts";
import { isUrgent, plainQuestion, QUEUE, type Question, type QuestionState, questionStates } from "./questions.ts";
import type { Store } from "./store.ts";

/** The longest a snooze may last: a year. A mistyped year would hide an item for good. */
export const SNOOZE_MAX_MS = 366 * 86_400_000;
/** The shortest: a snooze that ends before the page reloads is no snooze. */
export const SNOOZE_MIN_MS = 30_000;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Pure: the time a snooze request names, as an ISO time, or why it is refused. Only an absolute time counts: the page works out "1 hour" and "tomorrow morning" in the browser's own time zone. */
export function parseSnoozeUntil(
	raw: unknown,
	now: number,
): { ok: true; until: string } | { ok: false; error: string } {
	if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "until must be a date and time" };
	// A time with no zone ("2026-11-15T09:00:00") names no instant: it would be read in whatever zone this process runs in.
	if (!ISO_WITH_ZONE.test(raw.trim()))
		return { ok: false, error: "until must be an ISO time with its zone, like 2026-11-15T09:00:00Z" };
	const t = Date.parse(raw);
	if (Number.isNaN(t)) return { ok: false, error: "until is not a date and time" };
	if (t < now + SNOOZE_MIN_MS) return { ok: false, error: "until must be in the future" };
	if (t > now + SNOOZE_MAX_MS) return { ok: false, error: "until is more than a year away" };
	return { ok: true, until: new Date(t).toISOString() };
}

/** Notes each open hold that waits on this item. A hold is never closed, rewritten or duplicated by a snooze. */
function noteHolds(store: Store, id: string, text: string, now: Date) {
	for (const h of heldOpen(store)) if (heldForItem(h, id)) noteHeld(store, heldId(h), text, now);
}

/** Snoozes an open item until `until` (an ISO time, already checked), replacing any earlier snooze. Its holds stay open and are told when it returns. */
export function snoozeQuestion(store: Store, id: string, until: string, now = Date.now()) {
	store.tx(() => {
		store.items.patch(QUEUE, id, {
			snoozedUntil: until,
			snoozedAt: new Date(now).toISOString(),
			snoozeReturned: undefined,
		});
		noteHolds(
			store,
			id,
			`Snoozed on the queue until ${until.slice(0, 16)}Z. This hold stays open: the item is not answered.`,
			new Date(now),
		);
	});
}

/** Clears an item's snooze and says nothing: the answer, direction and dismissal paths use it, because settling an item ends its snooze. */
export const clearSnooze = (store: Store, id: string) =>
	store.items.patch(QUEUE, id, { snoozedUntil: undefined, snoozedAt: undefined, snoozeReturned: undefined });

/** Ends a snooze at once: the item is on the active list. */
export function unsnoozeQuestion(store: Store, id: string, now = Date.now()) {
	store.tx(() => {
		clearSnooze(store, id);
		noteHolds(store, id, "Un-snoozed on the queue: back on the active list.", new Date(now));
	});
}

/** A snoozed item whose time has passed, with the time it was snoozed until. */
type Due = { question: QuestionState; until: string };

/** The items whose snooze has ended and that the daemon has not yet handled, soonest return first. */
export function dueSnoozes(store: Store, now: number): QuestionState[] {
	return dueOf(store, now).map((d) => d.question);
}

function dueOf(store: Store, now: number): Due[] {
	const due: Due[] = [];
	for (const question of questionStates(store, now).values()) {
		const { snooze } = question;
		if (question.status === "open" && snooze && !snooze.active && !snooze.returned)
			due.push({ question, until: snooze.until });
	}
	return due.sort((a, b) => a.until.localeCompare(b.until));
}

/**
 * Handles each item whose snooze has ended, once: records it, tells its holds and returns it so the caller can notify. The record
 * is written before the notice, as the daemon's other notices are, so a crash loses at most one notice and never repeats one.
 * The caller notifies only the urgent ones (`isUrgent`): a question that can wait (`urgent: false`) comes back silently, as it was filed.
 */
export function returnDueSnoozes(store: Store, now = Date.now()): QuestionState[] {
	return dueOf(store, now).map((d) => {
		markReturned(store, d, now);
		return d.question;
	});
}

/** Records one return and tells the item's holds, in one transaction. */
function markReturned(store: Store, { question, until }: Due, now: number) {
	store.tx(() => {
		store.items.patch(QUEUE, question.id, { snoozeReturned: until });
		noteHolds(
			store,
			question.id,
			`Snooze ended (${until.slice(0, 16)}Z): the item is back on the active list.`,
			new Date(now),
		);
	});
}

export type ReturnDeps = {
	store: Store;
	now: number;
	/** A dry daemon records the return and posts nothing. */
	dry: boolean;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** The adapter that shows a question where the operator reads. */
	adapter: Adapter;
	post: (item: Question, adapter: Adapter) => Promise<PostResult>;
};

/**
 * The daemon's tick for snoozes: each question whose time has come is recorded once (`returnDueSnoozes`), and an urgent one is shown where the
 * operator reads again, as a new question is. A question that can wait comes back silently. A notice that fails is logged and never retried:
 * the question is on the active list either way.
 */
export async function announceReturns(d: ReturnDeps): Promise<void> {
	try {
		// Each return is recorded just before its own notice, never all at once: a crash during one post leaves the rest due, not lost.
		for (const due of dueOf(d.store, d.now)) {
			markReturned(d.store, due, d.now);
			const q = due.question;
			const notify = isUrgent(q) && !d.dry;
			d.log("snooze-returned", { id: q.id, notified: notify });
			if (!notify) continue;
			await d.post(plainQuestion(q), d.adapter).then(
				(r) => {
					if (!r.ok) d.log("snooze-post-failed", { id: q.id, detail: r.detail.slice(0, 200) });
				},
				(e) => d.log("snooze-post-failed", { id: q.id, detail: String(e).slice(0, 200) }),
			);
		}
	} catch (e) {
		d.log("snooze-return-error", { error: String(e).slice(0, 200) });
	}
}

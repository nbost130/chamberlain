/**
 * What the principal can do to an open question besides answer it with an option: snooze it until later, un-snooze it, give a
 * direction (a note, no option) or dismiss it. Kept out of the app's closure so each step is small enough to read and test on its own;
 * the app wires it to its serial queue and clock (./app.ts), and the routes are the full page's alone (`inlineVerdict`).
 */
import { closeHeldForItem } from "../core/afk.ts";
import { crashPoint } from "../core/crash.ts";
import {
	type AnswerKind,
	claimWake,
	enqueueClaim,
	PAGE,
	pageClaim,
	plainAnswer,
	type QuestionState,
	questionStates,
	wokenBy,
} from "../core/questions.ts";
import { clearSnooze, parseSnoozeUntil, snoozeQuestion, unsnoozeQuestion } from "../core/snooze.ts";
import type { Store } from "../core/store.ts";

/** A reply the page's API sends: its status and JSON body. */
export type Reply = { status: number; body: unknown };
const refuse = (status: number, error: string): Reply => ({ status, body: { error } });

/** The longest note a direction or a dismissal carries, as an answer's note is. */
const NOTE_MAX = 4000;
/** The routes under `/api/items/<id>/` that change an item's state without answering it with an option. */
export const ITEM_ACTIONS = new Set(["snooze", "unsnooze", "direction", "dismiss"]);

/** The reply for an item whose one wake is already claimed, by this page or by its question card in T3. */
export const takenReply = (owner: string): Reply =>
	refuse(409, owner === PAGE ? "already answered" : "already answered on its question card in T3");

const WHY_CLOSED: Record<Exclude<QuestionState["status"], "open">, string> = {
	dismissed: "already dismissed",
	answered: "already answered",
	"answered-on-card": "already answered on its question card in T3",
};
/**
 * Why an item cannot be answered, directed or dismissed here, or undefined when it can: the same refusals for every way of settling one.
 * A card pointer closes only when its card does, so settling it here would take it off the queue (and its hold off the ledger) while the
 * card still waits; the refusal says where to act.
 */
export function unsettleable(i: QuestionState): Reply | undefined {
	if (i.status !== "open") return refuse(409, WHY_CLOSED[i.status]);
	if (i.secret) return refuse(400, "a secret is entered in its own thread, never on this page");
	if (i.cardRequest)
		return refuse(
			409,
			"this question points to a question card waiting in its thread: act on the card itself; this question and its hold close only when the card does",
		);
	return undefined;
}

/** A note as the page keeps it: trimmed, within its length, and absent when blank. `undefined` for a value that is not text. */
function cleanNote(raw: unknown): { ok: true; note?: string } | { ok: false } {
	if (raw === undefined || raw === null) return { ok: true };
	if (typeof raw !== "string") return { ok: false };
	const note = raw.trim().slice(0, NOTE_MAX);
	return note ? { ok: true, note } : { ok: true };
}

export type ItemActionDeps = {
	store: Store;
	clock: () => number;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** The app's one-change-at-a-time queue: two requests for the same item must not both see it open. */
	serial: <T>(fn: () => T) => Promise<T>;
};

const stateOf = (d: ItemActionDeps, id: string) => questionStates(d.store, d.clock()).get(id);

/**
 * Closes the item's afk hold now, so it does not wait for the daemon's next pass. After the claim has committed, and best effort: the daemon's
 * reconciler (hold-reconcile.ts) closes it from the claim anyway, so a crash or a failure here loses nothing.
 */
function closeHolds(d: ItemActionDeps, id: string, kind: AnswerKind) {
	try {
		const how = `${kind === "direction" ? "Directed (direction, no option chosen)" : "Dismissed"} on the queue page; closed by the queue page.`;
		const n = closeHeldForItem(d.store, id, how);
		if (n) d.log("held-closed-for-item", { item: id, closed: n });
	} catch (e) {
		d.log("held-close-failed", { item: id, error: String(e).slice(0, 200) });
	}
}

/** Takes the item's one wake for a direction or a dismissal, in one transaction with its outbox row and the end of its snooze. */
function claimSettled(d: ItemActionDeps, i: QuestionState, kind: AnswerKind, note: string | undefined): Reply {
	const claim = pageClaim(i, plainAnswer(kind, i.id, note, new Date().toISOString()));
	const lost = d.store.tx(() => {
		const r = claimWake(d.store, claim);
		if (!r.won) return r.claim;
		enqueueClaim(d.store, claim);
		clearSnooze(d.store, i.id);
		crashPoint("before-commit");
		return undefined;
	});
	if (lost) return takenReply(lost.owner);
	crashPoint("committed");
	d.log(kind === "direction" ? "directed" : "dismissed", { id: i.id });
	closeHolds(d, i.id, kind);
	return { status: 200, body: { ok: true, id: i.id, kind, recorded: true, to: "steward", wake: "queued" } };
}

/**
 * Direction and Dismiss settle an item the way an answer does: one claim on the item's one wake, the wake's outbox row and the end of any
 * snooze, in one transaction. Direction is an answer, so the Steward reads it; a dismissal is recorded as dismissed and is never an
 * answer, a ruling or a settled-question match. Neither goes straight to the thread: the Steward has to read the note, or stop tracking.
 */
function settle(d: ItemActionDeps, id: string, kind: AnswerKind, raw: unknown): Promise<Reply> {
	return d.serial((): Reply => {
		const given = cleanNote(raw);
		if (!given.ok) return refuse(400, "note must be text");
		if (kind === "direction" && !given.note)
			return refuse(400, "a direction needs a note: write what the thread should do");
		const i = stateOf(d, id);
		if (!i) return refuse(404, "no such item");
		const held = wokenBy(d.store, i.id);
		const refused = unsettleable(i) ?? (held === undefined ? undefined : takenReply(held));
		return refused ?? claimSettled(d, i, kind, given.note);
	});
}

/** Snooze: the item stays open and unanswered, so its hold and its claim are untouched (src/core/snooze.ts). */
function snooze(d: ItemActionDeps, id: string, until: unknown): Promise<Reply> {
	return d.serial((): Reply => {
		if (stateOf(d, id)?.status !== "open") return refuse(404, "no open item");
		const at = parseSnoozeUntil(until, d.clock());
		if (!at.ok) return refuse(400, at.error);
		snoozeQuestion(d.store, id, at.until, d.clock());
		d.log("snoozed", { id, until: at.until });
		return { status: 200, body: { ok: true, id, until: at.until } };
	});
}

function unsnooze(d: ItemActionDeps, id: string): Promise<Reply> {
	return d.serial((): Reply => {
		const i = stateOf(d, id);
		if (i?.status !== "open") return refuse(404, "no open item");
		if (!i.snooze) return refuse(409, "that item is not snoozed");
		unsnoozeQuestion(d.store, id, d.clock());
		d.log("unsnoozed", { id });
		return { status: 200, body: { ok: true, id } };
	});
}

export function createItemActions(d: ItemActionDeps) {
	/** One of `ITEM_ACTIONS` on one item, with the request's JSON body. */
	function run(id: string, action: string, body: Record<string, unknown>): Promise<Reply> {
		if (action === "snooze") return snooze(d, id, body.until);
		if (action === "unsnooze") return unsnooze(d, id);
		return settle(d, id, action === "direction" ? "direction" : "dismissed", body.note);
	}
	return { run };
}

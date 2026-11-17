/**
 * What the principal can do to an open question besides answer it with an option: snooze it until later, un-snooze it, give a
 * direction (a note, no option) or dismiss it. Kept out of the app's closure so each step is small enough to read and test on its own;
 * the app wires it to its serial queue and clock (./app.ts). The full page does all four, and so does the Decisions view's key
 * (`mayDo` in ./view-key.ts). Each change is recorded with the key it was made with.
 */

import { crashPoint } from "../core/crash.ts";
import {
	type Answer,
	type AnswerKind,
	type KeyUsed,
	type QuestionState,
	questionStates,
} from "../core/items/questions.ts";
import { claimWake, enqueueClaim, PAGE, pageClaim, wokenBy } from "../core/items/questions-claim.ts";
import { plainAnswer } from "../core/items/questions-wake.ts";
import { clearSnooze, parseSnoozeUntil, snoozeQuestionAs, unsnoozeQuestion } from "../core/items/snooze.ts";
import { closeHeldForItem } from "../core/ops/afk-held.ts";
import type { Store } from "../core/store/store.ts";

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
 * Why an item cannot be answered or directed here, or undefined when it can. A dismissal is different: every open item may be
 * dismissed (including a secret and a card pointer), so callers that dismiss skip this and only check that the item is still open.
 * Answering or directing a secret or a card pointer here would take a value or a choice the page must never carry; the refusal
 * says where to act. A card pointer's card stays in its thread until acted on there, even after a dismissal.
 */
export function unsettleable(i: QuestionState): Reply | undefined {
	if (i.status !== "open") return refuse(409, WHY_CLOSED[i.status]);
	if (i.secret) return refuse(400, "a secret is entered in its own thread, never on this page");
	if (i.cardRequest)
		return refuse(
			409,
			"this question points to a question card waiting in its thread: act on the card itself, or dismiss this item to stop tracking it without answering the card",
		);
	return undefined;
}

/** Why an item cannot be dismissed here, or undefined when it can: closed ones only. A secret and a card pointer may be dismissed. */
function undismissable(i: QuestionState): Reply | undefined {
	if (i.status !== "open") return refuse(409, WHY_CLOSED[i.status]);
	return undefined;
}

/** A note as the page keeps it: trimmed, within its length, and absent when blank. `undefined` for a value that is not text. */
function cleanNote(raw: unknown): { ok: true; note?: string } | { ok: false } {
	if (raw === undefined || raw === null) return { ok: true };
	if (typeof raw !== "string") return { ok: false };
	const note = raw.trim().slice(0, NOTE_MAX);
	return note ? { ok: true, note } : { ok: true };
}

/** The item an action is on and the key the request proved. */
type Act = { id: string; key: KeyUsed };

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
function claimSettled(d: ItemActionDeps, i: QuestionState, answer: Answer): Reply {
	const claim = pageClaim(i, answer);
	const kind = answer.kind ?? "dismissed";
	const lost = d.store.tx(() => {
		const r = claimWake(d.store, claim);
		if (!r.won) return r.claim;
		enqueueClaim(d.store, claim, claim.message, d.clock());
		clearSnooze(d.store, i.id);
		crashPoint("before-commit");
		return undefined;
	});
	if (lost) return takenReply(lost.owner);
	crashPoint("committed");
	d.log(kind === "direction" ? "directed" : "dismissed", { id: i.id, key: answer.key });
	closeHolds(d, i.id, kind);
	return { status: 200, body: { ok: true, id: i.id, kind, recorded: true, to: "steward", wake: "queued" } };
}

/**
 * Direction and Dismiss settle an item the way an answer does: one claim on the item's one wake, the wake's outbox row and the end of any
 * snooze, in one transaction. Direction is an answer, so the Steward reads it; a dismissal is recorded as dismissed and is never an
 * answer, a ruling or a settled-question match. Neither goes straight to the thread: the Steward has to read the note, or stop tracking.
 * A dismissal may close a secret or a card pointer; it never enters a secret and never answers or approves the card behind a pointer.
 */
function settle(d: ItemActionDeps, act: Act, kind: AnswerKind, raw: unknown): Promise<Reply> {
	const { id, key } = act;
	return d.serial((): Reply => {
		const given = cleanNote(raw);
		if (!given.ok) return refuse(400, "note must be text");
		if (kind === "direction" && !given.note)
			return refuse(400, "a direction needs a note: write what the thread should do");
		const i = stateOf(d, id);
		if (!i) return refuse(404, "no such item");
		const held = wokenBy(d.store, i.id);
		const gate = kind === "dismissed" ? undismissable(i) : unsettleable(i);
		const refused = gate ?? (held === undefined ? undefined : takenReply(held));
		const answer = { ...plainAnswer(kind, i.id, given.note, new Date().toISOString()), key };
		return refused ?? claimSettled(d, i, answer);
	});
}

/** Snooze: the item stays open and unanswered, so its hold and its claim are untouched (src/core/items/snooze.ts). */
function snooze(d: ItemActionDeps, act: Act, until: unknown): Promise<Reply> {
	const { id, key } = act;
	return d.serial((): Reply => {
		if (stateOf(d, id)?.status !== "open") return refuse(404, "no open item");
		const at = parseSnoozeUntil(until, d.clock());
		if (!at.ok) return refuse(400, at.error);
		snoozeQuestionAs(d.store, id, at.until, { now: d.clock(), key });
		d.log("snoozed", { id, until: at.until, key });
		return { status: 200, body: { ok: true, id, until: at.until } };
	});
}

function unsnooze(d: ItemActionDeps, act: Act): Promise<Reply> {
	const { id, key } = act;
	return d.serial((): Reply => {
		const i = stateOf(d, id);
		if (i?.status !== "open") return refuse(404, "no open item");
		if (!i.snooze) return refuse(409, "that item is not snoozed");
		unsnoozeQuestion(d.store, id, d.clock());
		d.log("unsnoozed", { id, key });
		return { status: 200, body: { ok: true, id } };
	});
}

export function createItemActions(d: ItemActionDeps) {
	/** One of `ITEM_ACTIONS` on one item, with the request's JSON body and the key the request proved (recorded with the change). */
	function run(id: string, action: string, body: Record<string, unknown>, key: KeyUsed = "page"): Promise<Reply> {
		const act = { id, key };
		if (action === "snooze") return snooze(d, act, body.until);
		if (action === "unsnooze") return unsnooze(d, act);
		return settle(d, act, action === "direction" ? "direction" : "dismissed", body.note);
	}
	return { run };
}

/**
 * The daemon's hold for a card only the operator can clear: a command approval, a secret request, a machine-link request.
 * Nothing that waits on the operator is held without a decision-queue question, so before it holds a card the engine
 * files a question that POINTS to the card (a pointer item): the operator answers on the card in its own thread, and the
 * question and the hold both close when the card leaves the thread. No answering path is built here, and nothing of the
 * card's content travels: the question carries the thread, the server, the card's kind and the adapter's one-line label,
 * never a value, a command's output, or the card's questions and options. A secret card's question is itself `secret`, so
 * it is never posted and the page shows it only as a link to its thread.
 *
 * One question per card: `cardRequest` on the question is the card's request ID, and an open question or hold for the same
 * server and request is reused, so a card seen again files nothing new. The question carries a `notSettled` reason (a
 * pending card is a live request, never a settled question), so the settled check never refuses it.
 *
 * Which cards there are, and their kinds, is the adapter's (`Inspector.waiting`, normalized to `WaitKind` in adapter.ts):
 * this module reads only the normalized fields, so it imports no adapter.
 *
 * A card is keyed by (server, request ID) everywhere: filing, de-duplication, closing and reconciling. Two servers may use
 * the same request ID; one resolving never touches the other. What closing needs, the server, the thread and the request ID,
 * is stored on the hold (`card`) and on the question (`server`, `threadId`, `cardRequest`), so `reconcileCardHolds` can close
 * a card that resolved while the daemon was down.
 *
 * A card hold closes on POSITIVE EVIDENCE ONLY, or by the operator. The one evidence is the backend showing THAT card's own item,
 * matched on (server, request ID), in a terminal status (adapter.ts `WaitingRead.resolved`; for T3: completed, cancelled,
 * failed or interrupted). Absence is never evidence: a backend's read of a thread can be a bounded window of its history (T3's
 * is), so a card missing from it may still wait; a thread that is gone, archived or unreadable proves nothing either. Answering
 * the pointer question changes nothing (the page refuses it and the item reconciler skips it). A hold that sees no terminal
 * evidence for longer than a set period raises an alarm in the engine, naming the hold, the card and the command that closes it
 * by hand (`closeCardByHand`, `afk.ts close-card`). Nothing closes such a card on its own.
 */

import type { WaitingItem, WaitKind } from "./adapter-waiting.ts";
import { appendHeld, type CardRef, closeHeldForCard, closeHeldWhere, heldOpen } from "./afk-held.ts";
import { CARD_UNVERIFIED, cardAlarmKey, cardKey, cardRefOf, openCards, sameCard } from "./card-open.ts";
import { ledgerEvents } from "./obs/ledger.ts";
import { askQuestion, newItemId, QUEUE, type Question, questionStates } from "./questions.ts";
import type { Store } from "./store.ts";

/** What the engine passes on of one waiting card. The card's questions, options and any value are not part of it. */
export type CardWait = {
	thread: string;
	server: string;
	threadId: string;
	requestId: string;
	type: WaitKind;
	label: string;
};

/** Pure: the fields of a waiting item that may travel. Everything else on it (its questions and options) is dropped here. */
export const cardWaitOf = (
	w: Pick<WaitingItem, "type" | "requestId" | "label">,
	at: { thread: string; server: string; threadId: string },
): CardWait => ({
	thread: at.thread,
	server: at.server,
	threadId: at.threadId,
	requestId: w.requestId,
	type: w.type,
	label: w.label,
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

type WaitWords = { noun: string; tag: string; asks: string; hold: string };
/** The words for a command approval, which is also what any kind not listed in WHAT is called. */
const APPROVAL_REQUEST: WaitWords = {
	noun: "command approval",
	tag: "Approval",
	asks: "approval to run a command or use a permission",
	hold: "command or permission approval",
};

const WHAT: Record<string, WaitWords> = {
	secret_request: {
		noun: "secret",
		tag: "Secret",
		asks: "a secret (the value is entered in its thread, never here)",
		hold: "secret request",
	},
	link_request: {
		noun: "machine-link approval",
		tag: "Approval",
		asks: "approval to link two machines",
		hold: "approval to link two machines",
	},
	approval_request: APPROVAL_REQUEST,
};
const kindOf = (type: string) => WHAT[type] ?? APPROVAL_REQUEST;

/** Pure: the hold's one-line text: the card's kind and the adapter's label. */
const holdText = (w: Pick<CardWait, "type" | "label">) =>
	`${kindOf(w.type).hold}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`;

/** Pure: the pointer question for a card, built from the CardWait fields only. */
export function cardQuestion(w: CardWait, id: string, createdAt: string): Question {
	const k = kindOf(w.type);
	const secret = w.type === "secret_request";
	return {
		id,
		kind: "only-you",
		title: `${clip(flat(w.thread), 60)} waits on your ${k.noun}`,
		context: [
			`- Thread: ${clip(flat(w.thread), 120)} (on ${flat(w.server)})`,
			`- It asks for: ${k.asks}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`,
			"- Act on the question card itself, in its thread. This question and its hold close only when the card does; answering here closes nothing.",
			...(secret ? ["- The value never goes through this queue."] : []),
		].join("\n"),
		// Neither option says the card was handled: the page refuses an answer to a pointer, and only the card resolving closes it.
		options: [{ label: "Open the question card in its thread" }, { label: "Leave the question card waiting" }],
		thread: clip(flat(w.thread), 80),
		server: w.server,
		threadId: w.threadId,
		tag: k.tag,
		...(secret ? { secret: true } : {}),
		cardRequest: w.requestId,
		notSettled: "a pending card is a live request, not a settled question",
		createdAt,
	};
}

/** The open question that points to this card, if one was filed. */
export function questionForCard(store: Store, server: string, requestId: string): string | undefined {
	for (const q of questionStates(store).values())
		if (q.status === "open" && q.cardRequest === requestId && q.server === server) return q.id;
	return undefined;
}

/**
 * Hold a card for the operator, behind its pointer question, in one transaction (nested in the caller's when there is one).
 * Idempotent per card: an open hold or question for the same server and request is reused. Returns the question, whether it
 * was filed now (`filed`: the caller may post it) and whether a hold was written now (`held`).
 */
export function holdCard(
	store: Store,
	w: CardWait,
	now = new Date(),
	newId: () => string = newItemId,
): { item: string; question?: Question; filed: boolean; held: boolean } {
	return store.tx(() => {
		let item = questionForCard(store, w.server, w.requestId);
		let question: Question | undefined;
		if (!item) {
			question = cardQuestion(w, newId(), now.toISOString());
			askQuestion(store, question, now.getTime());
			item = question.id;
		}
		if (heldOpen(store).some((h) => sameCard(cardRefOf(h), w)))
			return { item, ...(question ? { question } : {}), filed: Boolean(question), held: false };
		// The sequence value the hold is written with: only a read started with a greater value may close it.
		appendHeld(
			store,
			{
				thread: clip(w.thread, 80),
				server: w.server,
				requestId: w.requestId,
				what: holdText(w),
				taken: "left parked",
				item,
				card: { server: w.server, threadId: w.threadId, requestId: w.requestId },
				seq: store.sequence.next(),
			},
			now,
		);
		return { item, ...(question ? { question } : {}), filed: Boolean(question), held: true };
	});
}

/** The card left its thread (answered or withdrawn there): its open pointer questions close with it, as answered on the card. */
export function closeCardQuestions(store: Store, server: string, requestId: string, now = Date.now()): number {
	return store.tx(() => {
		let n = 0;
		for (const q of questionStates(store).values()) {
			if (q.status !== "open" || q.cardRequest !== requestId || q.server !== server) continue;
			store.items.resolve(QUEUE, q.id, now, { answeredOnCard: true });
			ledgerEvents(store).answered(q.id);
			n++;
		}
		return n;
	});
}

/**
 * The card (server, request ID) resolved or vanished: its open pointer questions close as answered on the card, its open card
 * holds close, and so do the Steward's holds that name its thread, all in ONE transaction, so a card hold never closes without
 * its pointer question or the other way round. This is the only code that closes a card hold. Idempotent: a second call closes nothing.
 */
export function closeCard(
	store: Store,
	c: Pick<CardRef, "server" | "requestId"> & { threadId?: string },
	how: string,
	{ now = new Date(), writtenBefore }: { now?: Date; writtenBefore?: number } = {},
): { questions: number; holds: number } {
	return store.tx(() => {
		// With `writtenBefore` (a read's sequence value), the card closes only when it has an open hold and EVERY open hold of it
		// was written with a smaller value, judged on the holds as they are NOW, inside this transaction; otherwise nothing closes.
		// So a hold written while the read was out stays, with its question, and a hold never closes without its question.
		if (writtenBefore !== undefined) {
			const mine = heldOpen(store).filter((h) => sameCard(cardRefOf(h), c));
			if (!mine.length || !mine.every((h) => typeof h.seq === "number" && h.seq < writtenBefore))
				return { questions: 0, holds: 0 };
		}
		const cards = closeHeldWhere(store, (h) => (sameCard(cardRefOf(h), c) ? how : undefined), now);
		const questions = closeCardQuestions(store, c.server, c.requestId, now.getTime());
		// A closed card is no longer unverifiable, and its alarm (if one was raised) is over.
		store.items.resolve(CARD_UNVERIFIED, cardKey(c), now.getTime());
		store.items.resolve("alarm", cardAlarmKey(c), now.getTime());
		return { questions, holds: cards + (c.threadId ? closeHeldForCard(store, c.server, c.threadId, how) : 0) };
	});
}

/**
 * The operator closes a card by hand: the one way out for a card with no terminal evidence (its thread gone, its item out of the read's window, its reads failing).
 * Closes its pointer question and every open hold of it, in one transaction, like `closeCard`. Throws when nothing of that
 * card is open. The thread, when the hold or question knows it, lets the Steward's holds naming it close too.
 */
export function closeCardByHand(
	store: Store,
	{ server, requestId }: Pick<CardRef, "server" | "requestId">,
	how: string,
	now = new Date(),
): { questions: number; holds: number } {
	return store.tx(() => {
		const c = openCards(store).find((x) => x.server === server && x.requestId === requestId);
		if (!c) throw Error(`no open card hold or question for ${server} request ${requestId}`);
		return closeCard(
			store,
			{ server, requestId, ...(c.threadId ? { threadId: c.threadId } : {}) },
			`${how} (closed by hand)`,
			{ now },
		);
	});
}

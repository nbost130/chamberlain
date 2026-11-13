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
 */
import { appendHeld, heldOpen } from "./afk.ts";
import type { WaitingItem, WaitKind } from "./adapter.ts";
import { askQuestion, newItemId, questionStates, QUEUE, type Question } from "./questions.ts";
import type { Store } from "./store.ts";

/** What the engine passes on of one waiting card. The card's questions, options and any value are not part of it. */
export type CardWait = { thread: string; server: string; threadId: string; requestId: string; type: WaitKind; label: string };

/** Pure: the fields of a waiting item that may travel. Everything else on it (its questions and options) is dropped here. */
export const cardWaitOf = (w: Pick<WaitingItem, "type" | "requestId" | "label">, at: { thread: string; server: string; threadId: string }): CardWait =>
	({ thread: at.thread, server: at.server, threadId: at.threadId, requestId: w.requestId, type: w.type, label: w.label });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const WHAT: Record<string, { noun: string; tag: string; asks: string; hold: string }> = {
	secret_request: { noun: "secret", tag: "Secret", asks: "a secret (the value is entered in its thread, never here)", hold: "secret request" },
	link_request: { noun: "machine-link approval", tag: "Approval", asks: "approval to link two machines", hold: "approval to link two machines" },
	approval_request: { noun: "command approval", tag: "Approval", asks: "approval to run a command or use a permission", hold: "command or permission approval" },
};
const kindOf = (type: string) => WHAT[type] ?? WHAT.approval_request!;

/** Pure: the hold's one-line text: the card's kind and the adapter's label. */
export const holdText = (w: Pick<CardWait, "type" | "label">) => `${kindOf(w.type).hold}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`;

/** Pure: the pointer question for a card, built from the CardWait fields only. */
export function cardQuestion(w: CardWait, id: string, createdAt: string): Question {
	const k = kindOf(w.type);
	const secret = w.type === "secret_request";
	return {
		id, kind: "only-you",
		title: `${clip(flat(w.thread), 60)} waits on your ${k.noun}`,
		context: [
			`- Thread: ${clip(flat(w.thread), 120)} (on ${flat(w.server)})`,
			`- It asks for: ${k.asks}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`,
			"- Answer it on the thread's own card. This question closes when the card does.",
			...(secret ? ["- The value never goes through this queue."] : []),
		].join("\n"),
		options: [{ label: "Answered on the card" }, { label: "Leave it for now" }],
		thread: clip(flat(w.thread), 80), server: w.server, threadId: w.threadId, tag: k.tag,
		...(secret ? { secret: true } : {}),
		cardRequest: w.requestId,
		notSettled: "a pending card is a live request, not a settled question",
		createdAt,
	};
}

/** The open question that points to this card, if one was filed. */
export function questionForCard(store: Store, server: string, requestId: string): string | undefined {
	for (const q of questionStates(store).values()) if (q.status === "open" && q.cardRequest === requestId && q.server === server) return q.id;
	return undefined;
}

/**
 * Hold a card for the operator, behind its pointer question, in one transaction (nested in the caller's when there is one).
 * Idempotent per card: an open hold or question for the same server and request is reused. Returns the question, whether it
 * was filed now (`filed`: the caller may post it) and whether a hold was written now (`held`).
 */
export function holdCard(store: Store, w: CardWait, now = new Date(), newId: () => string = newItemId): { item: string; question?: Question; filed: boolean; held: boolean } {
	return store.tx(() => {
		let item = questionForCard(store, w.server, w.requestId);
		let question: Question | undefined;
		if (!item) {
			question = cardQuestion(w, newId(), now.toISOString());
			askQuestion(store, question, now.getTime());
			item = question.id;
		}
		if (heldOpen(store).some((h) => h.server === w.server && h.requestId === w.requestId)) return { item, ...(question ? { question } : {}), filed: Boolean(question), held: false };
		appendHeld(store, { thread: clip(w.thread, 80), server: w.server, requestId: w.requestId, what: holdText(w), taken: "left parked", item }, now);
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
			n++;
		}
		return n;
	});
}

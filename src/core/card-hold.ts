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
 * the same request ID; one resolving never touches the other. A card hold closes ONLY when its card resolves: answering
 * its pointer question changes nothing (the page refuses it and the item reconciler skips it). What closing needs, the
 * server, the thread and the request ID, is stored on the hold (`card`) and on the question (`server`, `threadId`,
 * `cardRequest`), so `reconcileCardHolds` can close a card that resolved or vanished while the daemon was down.
 */
import { appendHeld, closeHeldForCard, closeHeldWhere, heldOpen, isCardHold, type CardRef, type Held } from "./afk.ts";
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
			"- Act on the card itself, in its thread. This question and its hold close only when the card does; answering here closes nothing.",
			...(secret ? ["- The value never goes through this queue."] : []),
		].join("\n"),
		// Neither option says the card was handled: the page refuses an answer to a pointer, and only the card resolving closes it.
		options: [{ label: "Open the card in its thread" }, { label: "Leave the card waiting" }],
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
		if (heldOpen(store).some((h) => sameCard(cardRefOf(h), w))) return { item, ...(question ? { question } : {}), filed: Boolean(question), held: false };
		appendHeld(store, { thread: clip(w.thread, 80), server: w.server, requestId: w.requestId, what: holdText(w), taken: "left parked", item, card: { server: w.server, threadId: w.threadId, requestId: w.requestId } }, now);
		return { item, ...(question ? { question } : {}), filed: Boolean(question), held: true };
	});
}

const sameCard = (a: Pick<CardRef, "server" | "requestId"> | undefined, b: Pick<CardRef, "server" | "requestId">) => a !== undefined && a.server === b.server && a.requestId === b.requestId;
/** Pure: a hold's card as far as the hold itself says (its `card`, or the server and request ID an older hold carries). */
const cardRefOf = (h: Held): Partial<CardRef> & Pick<CardRef, "server" | "requestId"> | undefined =>
	h.card ?? (isCardHold(h) && h.server && h.requestId ? { server: h.server, requestId: h.requestId } : undefined);

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

/**
 * The card (server, request ID) resolved or vanished: its open pointer questions close as answered on the card, its open card
 * holds close, and so do the Steward's holds that name its thread, all in ONE transaction, so a card hold never closes without
 * its pointer question or the other way round. This is the only code that closes a card hold. Idempotent: a second call closes nothing.
 */
export function closeCard(store: Store, c: CardRef, how: string, now = new Date()): { questions: number; holds: number } {
	return store.tx(() => {
		const questions = closeCardQuestions(store, c.server, c.requestId, now.getTime());
		const cards = closeHeldWhere(store, (h) => (sameCard(cardRefOf(h), c) ? how : undefined), now);
		return { questions, holds: cards + closeHeldForCard(store, c.server, c.threadId, how) };
	});
}

/** What a fresh read of one thread on one server says: the request IDs waiting there now, the thread gone, or nothing known. */
export type CardThreadRead = { state: "read"; waiting: ReadonlySet<string> } | { state: "gone" } | { state: "unknown" };

/**
 * Every open card hold and every open pointer question, as the cards they wait on, keyed by (server, request ID). The
 * card's thread comes from the hold's `card`, else from its pointer question (a hold written before `card` existed). A
 * card whose thread cannot be told is left out: it is never closed on a guess.
 */
export function openCards(store: Store): CardRef[] {
	const out = new Map<string, CardRef>();
	const qs = questionStates(store);
	const add = (c: Partial<CardRef>) => { if (c.server && c.threadId && c.requestId) out.set(`${c.server}\0${c.requestId}`, { server: c.server, threadId: c.threadId, requestId: c.requestId }); };
	for (const q of qs.values()) if (q.status === "open" && q.cardRequest) add({ server: q.server, threadId: q.threadId, requestId: q.cardRequest });
	for (const h of heldOpen(store)) {
		const c = cardRefOf(h);
		if (!c) continue;
		const q = h.item ? qs.get(h.item) : undefined;
		add({ ...c, threadId: c.threadId ?? (q?.cardRequest === c.requestId && q.server === c.server ? q.threadId : undefined) });
	}
	return [...out.values()];
}

/**
 * Close every card that is no longer waiting: on each tick and at startup, so a card answered or withdrawn while the daemon
 * was down, or whose thread vanished, does not leave its question and hold open. Each (server, thread) is read once; a read
 * that cannot say (`unknown`: the server is down, the read failed) leaves its cards open. A card closes exactly once: a
 * closed card is no longer open, so a later pass does not see it.
 */
export async function reconcileCardHolds(store: Store, read: (server: string, threadId: string) => Promise<CardThreadRead>, now = () => new Date()): Promise<{ closed: CardRef[]; unknown: number }> {
	const cards = openCards(store);
	const reads = new Map<string, Promise<CardThreadRead>>();
	const closed: CardRef[] = [];
	let unknown = 0;
	for (const c of cards) {
		const key = `${c.server}\0${c.threadId}`;
		if (!reads.has(key)) reads.set(key, read(c.server, c.threadId).catch((): CardThreadRead => ({ state: "unknown" })));
		const r = await reads.get(key)!;
		if (r.state === "unknown") { unknown++; continue; }
		if (r.state === "read" && r.waiting.has(c.requestId)) continue;
		const how = r.state === "gone" ? "The card's thread is gone from its server (closed by the daemon's card reconciler)." : "The card is no longer waiting in its thread: answered or withdrawn there (closed by the daemon's card reconciler).";
		const n = closeCard(store, c, how, now());
		if (n.questions || n.holds) closed.push(c);
	}
	return { closed, unknown };
}

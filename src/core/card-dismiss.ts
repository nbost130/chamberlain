/**
 * Mirrored waiting cards the operator has dismissed from the decision-queue views. A dismissal only hides that card from
 * Nathan's page and inline Decisions view: it never answers, approves, cancels or enters anything in the thread's request,
 * which stays live in its own thread. The durable record is one silenced item of source `card-dismiss`, keyed by the
 * server, thread and request id, so a reused request id in another thread is not hidden, and a new request id shows again.
 * No schema migration: the items table already holds every other durable page record of this shape (card-answers.ts).
 */
import type { KeyUsed } from "./questions.ts";
import type { Store } from "./store.ts";

const CARD_DISMISS = "card-dismiss";

/** The dedup key for one mirrored request in one thread: a new request id is a new key; another thread's same request id is not. */
const cardDismissKey = (server: string, threadId: string, requestId: string) => `${server}\0${threadId}\0${requestId}`;

export type DismissableCard = { id: string; server: string; threadId: string; requestId: string; type: string };

/** True when this server's thread request has been dismissed from the views (the thread request is untouched). */
export function isCardDismissed(store: Store, server: string, threadId: string, requestId: string): boolean {
	return store.items.get(CARD_DISMISS, cardDismissKey(server, threadId, requestId)) !== undefined;
}

/**
 * Records a view-only dismissal. `ok` on the first call; `already` when this thread's request was dismissed before (HTTP 409).
 * Never touches the adapter or the thread.
 */
export function dismissCard(
	store: Store,
	card: DismissableCard,
	o: { key: KeyUsed; note?: string; now?: number },
): "ok" | "already" {
	const key = cardDismissKey(card.server, card.threadId, card.requestId);
	return store.tx(() => {
		if (store.items.get(CARD_DISMISS, key)) return "already";
		store.items.observe({
			source: CARD_DISMISS,
			kind: "card_dismiss",
			dedupKey: key,
			mode: "silenced",
			baseline: true,
			subject: { kind: "card", id: card.id },
			payload: {
				server: card.server,
				threadId: card.threadId,
				requestId: card.requestId,
				cardId: card.id,
				type: card.type,
				key: o.key,
				...(o.note ? { note: o.note } : {}),
			},
			now: o.now,
		});
		return "ok";
	});
}

/**
 * Mirrored waiting cards the operator has dismissed from the decision-queue views. A dismissal only hides that card from
 * Nathan's page and inline Decisions view: it never answers, approves, cancels or enters anything in the thread's request,
 * which stays live in its own thread. The durable record is one silenced item of source `card-dismiss`, keyed by the
 * server and the request id, so a new request (a new request id) shows again. No schema migration: the items table
 * already holds every other durable page record of this shape (card-answers.ts).
 */
import type { KeyUsed } from "./questions.ts";
import type { Store } from "./store.ts";

const CARD_DISMISS = "card-dismiss";

/** The dedup key for one mirrored request: a new request id is a new key, so that card shows again. */
const cardDismissKey = (server: string, requestId: string) => `${server}\0${requestId}`;

export type DismissableCard = { id: string; server: string; requestId: string; type: string };

/** True when this server's request has been dismissed from the views (the thread request is untouched). */
export function isCardDismissed(store: Store, server: string, requestId: string): boolean {
	return store.items.get(CARD_DISMISS, cardDismissKey(server, requestId)) !== undefined;
}

/**
 * Records a view-only dismissal. `ok` on the first call; `already` when this request was dismissed before (HTTP 409).
 * Never touches the adapter or the thread.
 */
export function dismissCard(
	store: Store,
	card: DismissableCard,
	o: { key: KeyUsed; note?: string; now?: number },
): "ok" | "already" {
	const key = cardDismissKey(card.server, card.requestId);
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

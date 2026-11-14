/**
 * Answers to cards waiting in other threads, in the item system. A card answer is sent to its thread at most once for the card as
 * the operator saw it (its id and fingerprint), however many pages, processes or restarts try: the first claim wins, enforced by the
 * database, and every later one is refused. This used to be a map in the page's memory with an expiry, which a second page process or a
 * restart did not share; now it is an item of source `card-answer` with the one claim the queue's questions use.
 *
 *   reserve   one transaction: observe the item and claim it. True only for the first caller, across processes.
 *   settle    the answer was sent, or may have been (a reply lost to a timeout): the item resolves and the claim STAYS, so the same
 *             card as shown is never sent twice from here.
 *   release   the answer was certainly not sent (refused, stale, unreachable before dispatch): the claim is given up and the card can be
 *             answered again.
 *
 * A reservation that never settles (the process died mid-send) is retaken after `CARD_ANSWER_STALE_MS`: the adapter's fixed command ids let
 * the backend drop a repeat, so retaking it cannot send a second answer to the thread.
 */
import type { Store } from "./store.ts";

const CARD_ANSWER = "card-answer";
export const CARD_ANSWER_STALE_MS = 5 * 60_000;
const cardAnswerKey = (cardId: string, sig: string) => `${cardId}@${sig}`;

export function reserveCardAnswer(
	store: Store,
	o: { cardId: string; sig: string; choice: number; now?: number },
): boolean {
	const now = o.now ?? Date.now();
	const key = cardAnswerKey(o.cardId, o.sig);
	return store.tx(() => {
		const prior = store.claims.get(CARD_ANSWER, key);
		if (prior) {
			const unsettled = store.items.get(CARD_ANSWER, key)?.status === "triggered";
			if (!unsettled || now - Date.parse(prior.t) <= CARD_ANSWER_STALE_MS) return false;
			store.claims.release(CARD_ANSWER, key);
		}
		store.items.observe({
			source: CARD_ANSWER,
			kind: "card_answer",
			dedupKey: key,
			mode: "silenced",
			subject: { kind: "card", id: o.cardId },
			payload: { cardId: o.cardId, choice: o.choice },
			now,
		});
		return store.claims.claim(CARD_ANSWER, {
			owner: "page",
			item: key,
			deliveryId: `card-answer:${key}`,
			message: "",
			t: new Date(now).toISOString(),
			answer: { choice: o.choice },
		}).won;
	});
}
/** The answer was sent, or may have been: the card as shown is never sent again from here. */
export function settleCardAnswer(
	store: Store,
	cardId: string,
	sig: string,
	patch: Record<string, unknown> = {},
	now = Date.now(),
) {
	store.items.resolve(CARD_ANSWER, cardAnswerKey(cardId, sig), now, patch);
}
/** The answer was certainly not sent: the claim goes, and the card can be answered again. */
export function releaseCardAnswer(store: Store, cardId: string, sig: string, now = Date.now()) {
	store.tx(() => {
		const key = cardAnswerKey(cardId, sig);
		store.claims.release(CARD_ANSWER, key);
		store.items.resolve(CARD_ANSWER, key, now, { released: true });
	});
}

/** The page's claim on a question's one wake, its direct relay, and recovering claims a crash left. */

import { type Answer, QUEUE, type Question } from "./questions.ts";
import { answerRoute, answerWake, threadRelayMessage } from "./questions-wake.ts";
import type { Ruling } from "./rulings.ts";
import type { Store } from "./store.ts";

export const PAGE = "page";

/**
 * A claim on an item's one wake, and everything needed to send it: the wake text, its delivery ID, the owner, and for
 * the page the answer it carries and the ruling it saves. Whoever holds the claim can always send the wake from it,
 * so no crash after the claim can lose the answer.
 */
export type Claim = {
	owner: string;
	item: string;
	deliveryId: string;
	message: string;
	t: string;
	answer?: Answer;
	ruling?: Ruling;
	relay?: ClaimRelay;
};
/**
 * A thread-routed answer: the one message for the item's thread. The claim's `message` is then the Steward's
 * fallback wake, sent only if that send fails or is cut short.
 */
export type ClaimRelay = { server: string; threadId: string; message: string };

/** The page's claim: its answer's wake (or its thread message and fallback wake), built whole before the claim is made. */
export function pageClaim(i: Question, a: Answer, ruling?: Ruling): Claim {
	const r = answerRoute(i, a);
	const relay: ClaimRelay | undefined = r.direct
		? { server: r.server, threadId: r.threadId, message: threadRelayMessage(i, a, r.relay) }
		: undefined;
	const message = answerWake(i, a, r.direct ? "direct send failed" : r.why);
	return {
		owner: PAGE,
		item: i.id,
		deliveryId: a.deliveryId,
		message,
		t: a.t,
		answer: a,
		...(ruling ? { ruling } : {}),
		...(relay ? { relay } : {}),
	};
}

// ---- the one-wake ledger and the one direct send, over the Store ----------------------------------

/** Takes the question's one wake. The first claim wins across processes (a unique key), and every later claimant gets the winner's. */
export const claimWake = (store: Store, c: Claim): { won: boolean; claim: Claim } =>
	store.claims.claim(QUEUE, c) as { won: boolean; claim: Claim };
export const readClaim = (store: Store, itemId: string): Claim | undefined =>
	store.claims.get(QUEUE, itemId) as Claim | undefined;
export const wokenBy = (store: Store, itemId: string): string | undefined => readClaim(store, itemId)?.owner;
export const readClaims = (store: Store): Claim[] => store.claims.list(QUEUE) as Claim[];

export type RelayState = { started: boolean; outcome?: "delivered" | "failed"; detail?: string };
/**
 * A question's thread is sent to at most once, across restarts and crashes. `startRelay` is true only for the first
 * caller ever; a start with no outcome is a send cut short: it may or may not have reached the thread, so it is never
 * sent again and the Steward gets the fallback.
 */
export const readRelay = (store: Store, itemId: string): RelayState => store.claims.readRelay(QUEUE, itemId);
export const startRelay = (store: Store, itemId: string): boolean => store.claims.startRelay(QUEUE, itemId);
export const finishRelay = (store: Store, itemId: string, outcome: "delivered" | "failed", detail?: string) =>
	store.claims.finishRelay(QUEUE, itemId, { outcome, detail });

/** Writes a claim's wake (or the message given, a fallback) as an outbox row. False when the outbox already knows its id. */
export const enqueueClaim = (store: Store, c: Claim, message = c.message, now = Date.now()): boolean =>
	store.wakes.enqueue({ deliveryId: c.deliveryId, message, queuedAt: now });

/**
 * The claims a process owns are its wakes, whatever happened to the process that made them. Run at startup and on every heartbeat:
 * each owned, unresolved claim that is done is marked so; one whose delivery id the outbox knows (pending, delivered, dead-lettered,
 * cancelled) is left to the relay and the operator; any other is written to the outbox, under its one delivery id. Only the claims and
 * the outbox decide; thread state and a process's memory play no part.
 *
 * There is no age cutoff: a claim whose wake has not been delivered is written however old it is, because until it is delivered it is the
 * only record that the operator answered. maintain.ts never prunes an outbox row that an unresolved claim still names.
 */
export type RecoverOpts = {
	store: Store;
	owns: (owner: string) => boolean;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Is this claim finished? Default: its wake's row is delivered. */
	done?: (c: Claim) => boolean;
	/** Runs for an owned, unresolved claim that is done. */
	delivered?: (c: Claim) => void;
	/** Writes the wake. Default: the claim's message as an outbox row. */
	send?: (c: Claim) => unknown;
};
/** Recovers one claim: true when its wake was written. A claim that is not owned, is resolved, is done or is already in the outbox is left; a failure is logged. */
async function recoverOne(o: RecoverOpts, c: Claim): Promise<boolean> {
	if (!o.owns(c.owner)) return false;
	if (o.store.items.get(QUEUE, c.item)?.status === "resolved") return false;
	try {
		if (o.done ? o.done(c) : o.store.wakes.isDelivered(c.deliveryId)) {
			o.delivered?.(c);
			return false;
		}
		if (o.store.wakes.known(c.deliveryId)) return false;
		o.log("claim-recovered", { item: c.item, owner: c.owner, deliveryId: c.deliveryId });
		await (o.send ? o.send(c) : enqueueClaim(o.store, c));
		return true;
	} catch (e) {
		o.log("claim-recover-error", { item: c.item, error: String(e).slice(0, 200) });
		return false;
	}
}
export async function recoverClaims(o: RecoverOpts): Promise<{ sent: string[] }> {
	const sent: string[] = [];
	for (const c of readClaims(o.store)) if (await recoverOne(o, c)) sent.push(c.item);
	return { sent };
}

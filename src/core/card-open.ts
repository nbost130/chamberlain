/** The open cards: every open card hold and pointer question, as the cards they wait on, keyed by (server, request ID). */
import { type CardRef, type Held, heldId, heldOpen, isCardHold } from "./afk.ts";
import { type QuestionState, questionStates } from "./questions.ts";
import type { Store } from "./store.ts";

export const sameCard = (
	a: Pick<CardRef, "server" | "requestId"> | undefined,
	b: Pick<CardRef, "server" | "requestId">,
) => a !== undefined && a.server === b.server && a.requestId === b.requestId;
/** Pure: a hold's card as far as the hold itself says (its `card`, or the server and request ID an older hold carries). */
export const cardRefOf = (h: Held): (Partial<CardRef> & Pick<CardRef, "server" | "requestId">) | undefined =>
	h.card ?? (isCardHold(h) && h.server && h.requestId ? { server: h.server, requestId: h.requestId } : undefined);

/**
 * An open card, keyed by (server, request ID). `threadId` is undefined when neither its hold nor its question says it.
 * `holds` are its open holds: their handles (afk.ts `heldId`) and the sequence value each was written with (none for a hold
 * written before the sequence existed: such a hold is never closed by a read, only by hand).
 */
export type OpenCard = Pick<CardRef, "server" | "requestId"> & {
	threadId?: string;
	holds: { id: string; seq?: number }[];
};

/** The item source that records since when a card has had no evidence (its `firstSeen`), and the card's key in it. */
export const CARD_UNVERIFIED = "card-unverified";
export const cardKey = (c: Pick<CardRef, "server" | "requestId">) => `${c.server}\u0000${c.requestId}`;
/** The engine's alarm key for a card with no evidence for too long. */
export const cardAlarmKey = (c: Pick<CardRef, "server" | "requestId">) => `card-unverified:${c.server}:${c.requestId}`;

type CardHoldRef = { id: string; seq?: number };

/** Adds a card to `out`, keyed by (server, request ID): the first thread it is given wins, and its holds are gathered. A card with no server or request ID is not one. */
function addOpenCard(out: Map<string, OpenCard>, c: Partial<CardRef>, hold?: CardHoldRef): void {
	if (!c.server || !c.requestId) return;
	const key = cardKey({ server: c.server, requestId: c.requestId });
	const prev = out.get(key);
	const threadId = prev?.threadId ?? c.threadId;
	out.set(key, {
		server: c.server,
		requestId: c.requestId,
		...(threadId ? { threadId } : {}),
		holds: [...(prev?.holds ?? []), ...(hold ? [hold] : [])],
	});
}

/** One open hold's card, if it is a card hold, with the thread its pointer question gives when the hold has none (a hold written before `card` existed). */
function addHeldCard(out: Map<string, OpenCard>, h: Held, qs: Map<string, QuestionState>): void {
	const c = cardRefOf(h);
	if (!c) return;
	const q = h.item ? qs.get(h.item) : undefined;
	const seq = typeof h.seq === "number" && Number.isSafeInteger(h.seq) && h.seq > 0 ? h.seq : undefined;
	addOpenCard(
		out,
		{
			...c,
			threadId: c.threadId ?? (q?.cardRequest === c.requestId && q.server === c.server ? q.threadId : undefined),
		},
		{ id: heldId(h), ...(seq ? { seq } : {}) },
	);
}

/**
 * Every open card hold and every open pointer question, as the cards they wait on, keyed by (server, request ID). The card's
 * thread comes from the hold's `card`, else from its pointer question (a hold written before `card` existed). A card whose
 * thread cannot be told is listed with no `threadId`: it is never read, so it closes only by hand. Every card hold names its
 * server (`holdCard` writes it, and an entry with none is not a card here), so no card is ever resolved across servers.
 */
export function openCards(store: Store): OpenCard[] {
	const out = new Map<string, OpenCard>();
	const qs = questionStates(store);
	for (const q of qs.values())
		if (q.status === "open" && q.cardRequest)
			addOpenCard(out, { server: q.server, threadId: q.threadId, requestId: q.cardRequest });
	for (const h of heldOpen(store)) addHeldCard(out, h, qs);
	return [...out.values()];
}

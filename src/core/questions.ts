/**
 * The decision queue. A question is an item of the one item system (source "queue", kind "question", key its Q-id) with
 * its answer flow attached: the one-wake claim (`claims`), the direct send to its thread (`relays`) and its evidence
 * rows. ask.ts, the page and the daemon all write through the Store, so none rewrites another's lines. What a question
 * looks like now is composed from those rows (`questionStates`).
 */
import { randomBytes } from "node:crypto";
import type { Store } from "./store.ts";
import { principal, Principal } from "./config.ts";
import type { Ruling } from "./rulings.ts";

export type Kind = "only-you" | "product" | "ruling" | "idea";
export const KINDS: Kind[] = ["only-you", "product", "ruling", "idea"];
/**
 * `route: "thread"` sends this option straight to the item's thread, as its `relay` text, when the principal picks it with no
 * note; anything else goes to the Steward as an answer wake. Default "steward".
 */
export type Option = { label: string; detail?: string; route?: "thread" | "steward"; relay?: string };
export type Evidence = { type: "image" | "video" | "link"; path?: string; url?: string; caption?: string };
export type Question = {
	id: string;
	kind: Kind;
	title: string;
	context: string;
	options: Option[];
	recommended?: number;
	proposedRuling?: string;
	/** An ISO date or date-time the proposed ruling stops being in force; omitted for a standing one. */
	proposedExpires?: string;
	evidence?: Evidence[];
	thread: string;
	server: string;
	threadId?: string;
	blocks?: string;
	/** A short chip on the list: Deploy, Secret, Review, Release. */
	tag?: string;
	/** A secret is answered in its own thread, never on the page. */
	secret?: boolean;
	/**
	 * `false` marks a question that can wait: it is recorded and listed below every urgent one, and nothing is posted where
	 * the operator reads, so no notification goes out. Absent means urgent, so every question asked before this field is unchanged.
	 */
	urgent?: false;
	/** Why this was asked although a settled record matched it (ask.ts `notSettled`). Kept for the audit. */
	notSettled?: string;
	/**
	 * The backend request ID of the card this question points to (the daemon's hold for an approval, secret or link card,
	 * src/core/card-hold.ts). The question is answered on that card, and closes when the card leaves its thread.
	 */
	cardRequest?: string;
	createdAt: string;
};

export type Answer = { choice: number; label: string; note?: string; ruling?: { id: string; decides: string }; by: "page" | "batch"; t: string; deliveryId: string };
export type QuestionState = Question & {
	status: "open" | "answered" | "answered-on-card";
	answer?: Answer;
	delivered: boolean;
	notNowAt?: string;
	/** A thread-routed answer's direct send: whether it reached the item's thread. */
	relay?: { outcome: "delivered" | "failed"; t: string; detail?: string };
};

export const QUEUE = "queue";
/** A new question's ID: `Q-` and a short time-ordered, random tail. */
export const newItemId = () => `Q-${Date.now().toString(36).slice(-5)}${randomBytes(2).toString("hex")}`;
export const evidenceRoot = (state: string) => `${state}/evidence`;
/** Question IDs are minted by ask.ts and are the only names the evidence route accepts as a directory. */
export const ITEM_ID = /^Q-[a-z0-9]{4,16}$/;
/** The marker each card carries, so the page can find the card that shows its item. */
export const cardTag = (id: string) => `[${id}]`;
export const tagIn = (text: string): string | undefined => text.match(/\[(Q-[a-z0-9]{4,16})\]/)?.[1];

/**
 * Puts a question on the queue as an item (triggered but silenced: its answer, not its arrival, is what wakes the Steward) and
 * records its evidence rows, in one transaction. Asking the same id twice changes nothing.
 */
export function askQuestion(store: Store, q: Question, now = Date.now()) {
	const { evidence, ...rest } = q;
	store.tx(() => {
		if (store.items.get(QUEUE, q.id)) return;
		store.items.observe({ source: QUEUE, kind: "question", dedupKey: q.id, mode: "silenced", ...(q.threadId ? { subject: { kind: "thread", id: q.threadId } } : {}), payload: rest, now });
		if (evidence?.length) store.evidence.put(QUEUE, q.id, evidence.map((e) => ({ type: e.type, ...(e.path ? { name: e.path } : {}), ...(e.url ? { url: e.url } : {}), ...(e.caption ? { caption: e.caption } : {}) })));
	});
}

/** Every question and where it stands, composed from the item, its claim, its direct send and its evidence. */
export function questionStates(store: Store): Map<string, QuestionState> {
	const claims = new Map(store.claims.list(QUEUE).map((c) => [c.item, c]));
	const relays = store.claims.listRelays(QUEUE);
	const evidence = store.evidence.listAll(QUEUE);
	const out = new Map<string, QuestionState>();
	for (const i of store.items.list({ source: QUEUE, kind: "question" })) {
		const q = i.payload as unknown as Question;
		const claim = claims.get(i.dedupKey);
		const ev = evidence.get(i.dedupKey);
		const relay = relays.get(i.dedupKey);
		// Answered is the claim on its one wake (taken in the same transaction as the answer), or resolved.
			const answered = claim !== undefined || i.status === "resolved";
		out.set(i.dedupKey, {
			...q,
			...(ev?.length ? { evidence: ev.map((e): Evidence => ({ type: e.type, ...(e.name ? { path: e.name } : {}), ...(e.url ? { url: e.url } : {}), ...(e.caption ? { caption: e.caption } : {}) })) } : {}),
			status: i.payload.answeredOnCard === true ? "answered-on-card" : answered ? "answered" : "open",
			...(claim?.answer ? { answer: claim.answer as Answer } : {}),
			delivered: i.status === "resolved" && i.payload.answeredOnCard !== true,
			...(i.status === "acknowledged" && !answered && typeof i.payload.notNowAt === "string" ? { notNowAt: i.payload.notNowAt } : {}),
			...(relay?.outcome ? { relay: { outcome: relay.outcome, t: relay.t ?? "", ...(relay.detail ? { detail: relay.detail } : {}) } } : {}),
		});
	}
	return out;
}
export const getQuestion = (store: Store, id: string): QuestionState | undefined => questionStates(store).get(id);

/** Sets a question aside: it stays open and answerable, and sinks to the end of the ranking. */
export function notNow(store: Store, id: string, t = new Date().toISOString()) {
	store.items.acknowledge(QUEUE, id, Date.parse(t), { notNowAt: t });
}

const KIND_RANK: Record<Kind, number> = { "only-you": 0, product: 1, ruling: 2, idea: 3 };
/** How many threads an item holds up, read from its blocks text ("blocks 3 threads", "holds 2 PRs"). */
export const blockWeight = (blocks?: string) => (blocks ? Number(blocks.match(/\d+/)?.[0] ?? 1) || 1 : 0);

/**
 * Pure: the open queue, ranked. Non-urgent questions sit below every urgent one; within each of the two, "not now" sinks
 * to the end, then only-you first, then what blocks the most, then the oldest.
 */
export function ranked(items: Iterable<QuestionState>): QuestionState[] {
	return [...items].filter((i) => i.status === "open").sort((a, b) =>
		Number(a.urgent === false) - Number(b.urgent === false)
		|| Number(Boolean(a.notNowAt)) - Number(Boolean(b.notNowAt))
		|| KIND_RANK[a.kind] - KIND_RANK[b.kind]
		|| blockWeight(b.blocks) - blockWeight(a.blocks)
		|| a.createdAt.localeCompare(b.createdAt));
}

/** Pure: what "Accept all recommendations" may answer. Never an only-you item, a secret, or one with no recommendation. */
export function batchable(i: QuestionState): boolean {
	return i.status === "open" && i.kind !== "only-you" && !i.secret && i.recommended !== undefined && i.recommended >= 0 && i.recommended < i.options.length;
}

/** The wake that carries one answer, in the daemon's `[chamberlain] answer:` shape. Its delivery ID is the item's own. */
export const answerDeliveryId = (id: string) => `answer:item:${id}`;

/** Why an answer to an item with a thread-routed option still went to the Steward. */
export type StewardWhy = "steward option" | "custom answer" | "note present" | "ruling saved" | "direct send failed";
export type AnswerRoute = { direct: true; server: string; threadId: string; relay: string } | { direct: false; why?: StewardWhy };
/**
 * Pure: where an answer goes. Straight to the item's thread only when they picked a thread-routed option as it stands,
 * with no note and no ruling saved; then the Steward gets no wake. Otherwise the Steward does, and when the item has
 * any thread-routed option the wake says why this one didn't go direct. An item with none behaves as it always has.
 */
export function answerRoute(i: Question, a: Answer): AnswerRoute {
	if (!i.options.some((o) => o.route === "thread")) return { direct: false };
	const o = i.options[a.choice];
	if (!o || o.label !== a.label) return { direct: false, why: "custom answer" };
	if (o.route !== "thread" || !o.relay?.trim() || !i.threadId) return { direct: false, why: "steward option" };
	if (a.note?.trim()) return { direct: false, why: "note present" };
	if (a.ruling) return { direct: false, why: "ruling saved" };
	return { direct: true, server: i.server, threadId: i.threadId, relay: o.relay.trim() };
}

const WHY_TEXT: Record<StewardWhy, string> = {
	"steward option": "they picked an option routed to you",
	"custom answer": "they gave an answer of their own, not one of the options",
	"note present": "they left a note, and every note comes to you",
	"ruling saved": "they saved a ruling with it",
	"direct send failed": "this option goes straight to the thread, but the direct send to it failed, so relay it yourself",
};
/** For a send that timed out or was cut short: T3 may have taken it, so the Steward checks before sending again. */
const SEND_UNCERTAIN = "this option goes straight to the thread, but the direct send may or may not have reached the thread: check the thread before re-sending";
/** Pure: a send detail that leaves open whether T3 took the message (the send's own deadline passed, or a crash cut it short). */
export const sendUncertain = (detail: string) => /\bsend timed out\b|may or may not have reached/.test(detail);
/**
 * Pure: a thread-routed claim's fallback wake, with how the send ended. A send that may have delivered tells the Steward
 * to check the thread before re-sending; a plain failure keeps "relay it yourself".
 */
export function fallbackWake(message: string, detail: string): string {
	const flat = detail.replace(/\s+/g, " ").trim().slice(0, 200);
	const body = sendUncertain(detail) ? message.replace(WHY_TEXT["direct send failed"], SEND_UNCERTAIN) : message;
	return body.replace(/\n>>>$/, `\nsend error: ${flat}\n>>>`);
}

/** Pure: the one message a thread-routed answer sends to the item's thread. It starts "Steward", as the Steward's own relay would. */
export function threadRelayMessage(i: Question, a: Answer, relay: string): string {
	const flat = (s: string) => s.replace(/\s+/g, " ").trim();
	return [
		`Steward, relaying ${principal()}'s answer from the decision queue (item ${i.id}; Chamberlain sent it the moment they answered).`,
		`Question: ${flat(i.title)}`,
		`Their choice: ${flat(a.label)}`,
		a.note ? `Their note: ${a.note}` : "",
		`What to do: ${relay}`,
	].filter(Boolean).join("\n");
}

export function answerWake(i: Question, a: Answer, why?: StewardWhy): string {
	const chosen = i.options[a.choice];
	const relay = chosen?.label === a.label && chosen.route === "thread" ? chosen.relay : undefined;
	const lines = [
		`item: ${i.id}`,
		`question: ${i.title}`,
		`thread: ${i.thread}${i.threadId ? ` (${i.server}, ${i.threadId})` : ` (${i.server})`}`,
		`choice: ${a.choice + 1}. ${a.label}${a.by === "batch" ? " (accepted with every recommendation)" : ""}`,
		a.note ? `note: ${a.note}` : "note: none",
		a.ruling ? `ruling: saved as ${a.ruling.id}, in force and confirmed by ${principal()}: ${a.ruling.decides}` : "ruling: none saved; this answer settles this item only",
		...(why ? [`route: to you, not straight to the thread (${why}): ${WHY_TEXT[why]}`] : []),
		...(why && relay ? [`relay text for this option: ${relay}`] : []),
	];
	return `[chamberlain] answer: ${Principal()} answered decision-queue item ${i.id} on the queue page. These are their choices, from the page's record. One wake carries each item; if this item ID reaches you twice, the second is a repeat:\n<<<\n${lines.join("\n")}\n>>>`;
}

/** Records that an answer's wake delivered: the question is resolved. Idempotent; anything that isn't an answer's delivery ID is ignored. */
export function recordAnswerDelivered(store: Store, deliveryId: string) {
	const id = deliveryId.match(/^answer:item:(Q-[a-z0-9]{4,16})$/)?.[1];
	if (!id) return;
	store.tx(() => {
		const i = store.items.get(QUEUE, id);
		if (!i || i.status === "resolved" || store.claims.get(QUEUE, id)?.deliveryId !== deliveryId) return;
		store.items.resolve(QUEUE, id, Date.now());
	});
}

// ---- one wake per item --------------------------------------------------------------------------

export const PAGE = "page";

/**
 * A claim on an item's one wake, and everything needed to send it: the wake text, its delivery ID, the owner, and for
 * the page the answer it carries and the ruling it saves. Whoever holds the claim can always send the wake from it,
 * so no crash after the claim can lose the answer.
 */
export type Claim = { owner: string; item: string; deliveryId: string; message: string; t: string; answer?: Answer; ruling?: Ruling; relay?: ClaimRelay };
/**
 * A thread-routed answer: the one message for the item's thread. The claim's `message` is then the Steward's
 * fallback wake, sent only if that send fails or is cut short.
 */
export type ClaimRelay = { server: string; threadId: string; message: string };

/** The page's claim: its answer's wake (or its thread message and fallback wake), built whole before the claim is made. */
export function pageClaim(i: Question, a: Answer, ruling?: Ruling): Claim {
	const r = answerRoute(i, a);
	const relay: ClaimRelay | undefined = r.direct ? { server: r.server, threadId: r.threadId, message: threadRelayMessage(i, a, r.relay) } : undefined;
	const message = answerWake(i, a, r.direct ? "direct send failed" : r.why);
	return { owner: PAGE, item: i.id, deliveryId: a.deliveryId, message, t: a.t, answer: a, ...(ruling ? { ruling } : {}), ...(relay ? { relay } : {}) };
}

// ---- the one-wake ledger and the one direct send, over the Store ----------------------------------

/** Takes the question's one wake. The first claim wins across processes (a unique key), and every later claimant gets the winner's. */
export const claimWake = (store: Store, c: Claim): { won: boolean; claim: Claim } => store.claims.claim(QUEUE, c) as { won: boolean; claim: Claim };
export const readClaim = (store: Store, itemId: string): Claim | undefined => store.claims.get(QUEUE, itemId) as Claim | undefined;
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
export const finishRelay = (store: Store, itemId: string, outcome: "delivered" | "failed", detail?: string) => store.claims.finishRelay(QUEUE, itemId, outcome, detail);

/** Writes a claim's wake (or the message given, a fallback) as an outbox row. False when the outbox already knows its id. */
export const enqueueClaim = (store: Store, c: Claim, message = c.message, now = Date.now()): boolean => store.wakes.enqueue({ deliveryId: c.deliveryId, message, queuedAt: now });

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
export async function recoverClaims(o: RecoverOpts): Promise<{ sent: string[] }> {
	const sent: string[] = [];
	for (const c of readClaims(o.store)) {
		if (!o.owns(c.owner)) continue;
		if (o.store.items.get(QUEUE, c.item)?.status === "resolved") continue;
		try {
			if (o.done ? o.done(c) : o.store.wakes.isDelivered(c.deliveryId)) { o.delivered?.(c); continue; }
			if (o.store.wakes.known(c.deliveryId)) continue;
			o.log("claim-recovered", { item: c.item, owner: c.owner, deliveryId: c.deliveryId });
			await (o.send ? o.send(c) : enqueueClaim(o.store, c));
			sent.push(c.item);
		} catch (e) {
			o.log("claim-recover-error", { item: c.item, error: String(e).slice(0, 200) });
		}
	}
	return { sent };
}

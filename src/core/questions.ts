/**
 * The decision queue. A question is an item of the one item system (source "queue", kind "question", key its Q-id) with
 * its answer flow attached: the one-wake claim (`claims`), the direct send to its thread (`relays`) and its evidence
 * rows. ask.ts, the page and the daemon all write through the Store, so none rewrites another's lines. What a question
 * looks like now is composed from those rows (`questionStates`).
 */
import { randomBytes } from "node:crypto";
import { principal } from "./config.ts";
import { answerWakeText, dismissedWakeText } from "./messages.ts";
import type { Ruling } from "./rulings.ts";
import type { ClaimRecord, EvidenceRow, Item, RelayRecord, Store } from "./store.ts";

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

/**
 * What an answer is when no option was chosen: `direction` is a note and no option (an answer, so the Steward reads it), `dismissed`
 * is "already handled / no longer needed" (not an answer: it settles nothing). Both carry `choice: -1`.
 */
export type AnswerKind = "direction" | "dismissed";
export type Answer = {
	choice: number;
	label: string;
	note?: string;
	ruling?: { id: string; decides: string };
	by: "page" | "batch";
	t: string;
	deliveryId: string;
	kind?: AnswerKind;
};
/** A question put off until a time: the page keeps it off the active list while `active`, and the daemon tells the principal when it returns. */
type Snooze = {
	/** When it returns: an ISO time. */
	until: string;
	/** When it was snoozed. */
	at: string;
	/** `until` has not passed yet: the item is in the Snoozed section, not the active list. */
	active: boolean;
	/** The daemon has handled its return (src/core/snooze.ts `returnDueSnoozes`). */
	returned: boolean;
};
export type QuestionState = Question & {
	status: "open" | "answered" | "answered-on-card" | "dismissed";
	answer?: Answer;
	/** A dismissed item: "already handled / no longer needed", with the principal's optional note. Never an answer. */
	dismissal?: { note?: string; t: string };
	snooze?: Snooze;
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
 * Pure: an item that can never wait. A secret (`secret: true` or the tag "Secret"), an approval (the tag "Approval") and a
 * daemon's card pointer (`cardRequest`: an approval, secret or link card) are ALWAYS urgent: `urgent: false` on one is
 * ignored wherever it comes from (ask.ts says so on stderr), so none is ever posted late or listed under NOT URGENT.
 */
export const alwaysUrgent = (q: Pick<Question, "secret" | "tag" | "cardRequest">): boolean =>
	q.secret === true ||
	(typeof q.cardRequest === "string" && q.cardRequest !== "") ||
	/^\s*(approval|secret)\s*$/i.test(q.tag ?? "");
/** Pure: is this item urgent? Absent `urgent` is urgent, and so is every item `alwaysUrgent` names, whatever its field says. */
export const isUrgent = (q: Pick<Question, "urgent" | "secret" | "tag" | "cardRequest">): boolean =>
	q.urgent !== false || alwaysUrgent(q);
/** Pure: the item with an `urgent: false` it may not have removed. Every write and every read of a question goes through it. */
function withUrgency<T extends Pick<Question, "urgent" | "secret" | "tag" | "cardRequest">>(q: T): T {
	if (q.urgent !== false || !alwaysUrgent(q)) return q;
	const { urgent: _dropped, ...rest } = q;
	return rest as T;
}

/**
 * Puts a question on the queue as an item (triggered but silenced: its answer, not its arrival, is what wakes the Steward) and
 * records its evidence rows, in one transaction. Asking the same id twice changes nothing.
 */
export function askQuestion(store: Store, q: Question, now = Date.now()) {
	// An approval or a secret is always urgent: a demotion is dropped here, so no path that files a question can store one.
	const { evidence, ...rest } = withUrgency(q);
	store.tx(() => {
		if (store.items.get(QUEUE, q.id)) return;
		store.items.observe({
			source: QUEUE,
			kind: "question",
			dedupKey: q.id,
			mode: "silenced",
			...(q.threadId ? { subject: { kind: "thread", id: q.threadId } } : {}),
			payload: rest,
			now,
		});
		if (evidence?.length)
			store.evidence.put(
				QUEUE,
				q.id,
				evidence.map((e) => ({
					type: e.type,
					...(e.path ? { name: e.path } : {}),
					...(e.url ? { url: e.url } : {}),
					...(e.caption ? { caption: e.caption } : {}),
				})),
			);
	});
}

/** Pure: the question as it was filed, without the state read from its claim, relay and snooze. What an adapter posts. */
export function plainQuestion(q: QuestionState): Question {
	const { status: _s, answer: _a, dismissal: _d, snooze: _z, delivered: _v, notNowAt: _n, relay: _r, ...filed } = q;
	return filed;
}

/** The payload fields a snooze keeps (see `snoozeOf`): read into `snooze`, so they are not also left on the question. */
const SNOOZE_FIELDS = ["snoozedUntil", "snoozedAt", "snoozeReturned"] as const;
const withoutSnoozeFields = (q: Question): Question => {
	const filed: Record<string, unknown> = { ...q };
	for (const k of SNOOZE_FIELDS) delete filed[k];
	return filed as Question;
};

/**
 * Where a question stands, from its payload and its claim's answer: its status, the answer or the dismissal (a dismissal is recorded in the
 * claim but is never an answer, so it is read back as `dismissal`, never as `answer`) and the snooze an open item carries.
 */
function outcomeOf(
	payload: Record<string, unknown>,
	given: Answer | undefined,
	answered: boolean,
	now: number,
): Pick<QuestionState, "status" | "answer" | "dismissal" | "snooze"> {
	const dismissed = given?.kind === "dismissed";
	const snooze = answered ? undefined : snoozeOf(payload, now);
	const status =
		payload.answeredOnCard === true ? "answered-on-card" : dismissed ? "dismissed" : answered ? "answered" : "open";
	return {
		status,
		...(given && !dismissed ? { answer: given } : {}),
		...(given && dismissed ? { dismissal: { ...(given.note ? { note: given.note } : {}), t: given.t } } : {}),
		...(snooze ? { snooze } : {}),
	};
}

/** The snooze an open item carries, read against `now`: a snooze whose time has passed is not active, and the item is on the active list. */
function snoozeOf(payload: Record<string, unknown>, now: number): Snooze | undefined {
	if (typeof payload.snoozedUntil !== "string") return undefined;
	const until = Date.parse(payload.snoozedUntil);
	if (Number.isNaN(until)) return undefined;
	return {
		until: payload.snoozedUntil,
		at: typeof payload.snoozedAt === "string" ? payload.snoozedAt : payload.snoozedUntil,
		active: until > now,
		returned: payload.snoozeReturned === payload.snoozedUntil,
	};
}

/** `{}` unless `cond`, so an optional field is left off a state rather than set to undefined. */
const when = <T extends object>(cond: unknown, fields: T): Partial<T> => (cond ? fields : {});

/** Stored evidence rows as the evidence a question shows: the file's name is its path. */
const evidenceOf = (rows: EvidenceRow[]): Evidence[] =>
	rows.map(
		(e): Evidence => ({
			type: e.type,
			...(e.name ? { path: e.name } : {}),
			...(e.url ? { url: e.url } : {}),
			...(e.caption ? { caption: e.caption } : {}),
		}),
	);

/** One question's state, composed from its item, its claim, its direct send and its evidence rows. */
function stateOf(
	i: Item,
	claim: ClaimRecord | undefined,
	ev: EvidenceRow[] | undefined,
	relay: RelayRecord | undefined,
	now: number,
): QuestionState {
	// Answered is the claim on its one wake (taken in the same transaction as the answer), or resolved.
	const answered = claim !== undefined || i.status === "resolved";
	const onCard = i.payload.answeredOnCard === true;
	const setAside = i.payload.notNowAt;
	const outcome = relay?.outcome;
	const sent =
		relay && outcome ? { outcome, t: relay.t ?? "", ...(relay.detail ? { detail: relay.detail } : {}) } : undefined;
	const notNowAt = i.status === "acknowledged" && !answered && typeof setAside === "string" ? setAside : undefined;
	return {
		// A row stored before the always-urgent rule, or written around askQuestion, is read back urgent all the same.
		...withUrgency(withoutSnoozeFields(i.payload as unknown as Question)),
		...when(ev?.length, { evidence: evidenceOf(ev ?? []) }),
		...outcomeOf(i.payload, claim?.answer as Answer | undefined, answered, now),
		delivered: i.status === "resolved" && !onCard,
		...when(notNowAt !== undefined, { notNowAt }),
		...when(sent, { relay: sent }),
	};
}

/**
 * Every question and where it stands, composed from the item, its claim, its direct send and its evidence. `now` is the clock a snooze
 * is read against: nothing rewrites a snoozed item when its time passes, so it is back on the active list the moment `now` reaches it.
 */
export function questionStates(store: Store, now = Date.now()): Map<string, QuestionState> {
	const claims = new Map(store.claims.list(QUEUE).map((c) => [c.item, c]));
	const relays = store.claims.listRelays(QUEUE);
	const evidence = store.evidence.listAll(QUEUE);
	const out = new Map<string, QuestionState>();
	for (const i of store.items.list({ source: QUEUE, kind: "question" }))
		out.set(i.dedupKey, stateOf(i, claims.get(i.dedupKey), evidence.get(i.dedupKey), relays.get(i.dedupKey), now));
	return out;
}
export const getQuestion = (store: Store, id: string): QuestionState | undefined => questionStates(store).get(id);

/** Sets a question aside: it stays open and answerable, and sinks to the end of the ranking. */
export function notNow(store: Store, id: string, t = new Date().toISOString()) {
	store.items.acknowledge(QUEUE, id, Date.parse(t), { notNowAt: t });
}

const KIND_RANK: Record<Kind, number> = { "only-you": 0, product: 1, ruling: 2, idea: 3 };
/** How many threads an item holds up, read from its blocks text ("blocks 3 threads", "holds 2 PRs"). */
const blockWeight = (blocks?: string) => (blocks ? Number(blocks.match(/\d+/)?.[0] ?? 1) || 1 : 0);

/**
 * Pure: the active queue, ranked. A snoozed item is not in it (see `snoozed`). Non-urgent questions sit below every urgent one;
 * within each of the two, "not now" sinks to the end, then only-you first, then what blocks the most, then the oldest.
 */
export function ranked(items: Iterable<QuestionState>): QuestionState[] {
	return [...items]
		.filter((i) => i.status === "open" && !i.snooze?.active)
		.sort(
			(a, b) =>
				Number(!isUrgent(a)) - Number(!isUrgent(b)) ||
				Number(Boolean(a.notNowAt)) - Number(Boolean(b.notNowAt)) ||
				KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
				blockWeight(b.blocks) - blockWeight(a.blocks) ||
				a.createdAt.localeCompare(b.createdAt),
		);
}

/** Pure: the open items put off until later, soonest to return first. */
export const snoozed = (items: Iterable<QuestionState>): QuestionState[] =>
	[...items]
		.filter((i) => i.status === "open" && i.snooze?.active)
		.sort(
			(a, b) => (a.snooze?.until ?? "").localeCompare(b.snooze?.until ?? "") || a.createdAt.localeCompare(b.createdAt),
		);

/** Pure: what "Accept all recommendations" may answer. Never an only-you item, a secret, or one with no recommendation. */
export function batchable(i: QuestionState): boolean {
	return (
		i.status === "open" &&
		!i.snooze?.active &&
		i.kind !== "only-you" &&
		!i.secret &&
		i.recommended !== undefined &&
		i.recommended >= 0 &&
		i.recommended < i.options.length
	);
}

/** The wake that carries one answer, in the daemon's `[chamberlain] answer:` shape. Its delivery ID is the item's own. */
export const answerDeliveryId = (id: string) => `answer:item:${id}`;

/** Why an answer to an item with a thread-routed option still went to the Steward. */
export type StewardWhy = "steward option" | "custom answer" | "note present" | "ruling saved" | "direct send failed";
export type AnswerRoute =
	| { direct: true; server: string; threadId: string; relay: string }
	| { direct: false; why?: StewardWhy };
/**
 * Pure: where an answer goes. Straight to the item's thread only when they picked a thread-routed option as it stands,
 * with no note and no ruling saved; then the Steward gets no wake. Otherwise the Steward does, and when the item has
 * any thread-routed option the wake says why this one didn't go direct. An item with none behaves as it always has.
 */
export function answerRoute(i: Question, a: Answer): AnswerRoute {
	// A direction or a dismissal chose no option, so it has no relay text to send: the Steward always reads it.
	if (a.kind) return { direct: false };
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
	"direct send failed":
		"this option goes straight to the thread, but the direct send to it failed, so relay it yourself",
};
/** For a send that timed out or was cut short: T3 may have taken it, so the Steward checks before sending again. */
const SEND_UNCERTAIN =
	"this option goes straight to the thread, but the direct send may or may not have reached the thread: check the thread before re-sending";
/** Pure: a send detail that leaves open whether T3 took the message (the send's own deadline passed, or a crash cut it short). */
const sendUncertain = (detail: string) => /\bsend timed out\b|may or may not have reached/.test(detail);
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
function threadRelayMessage(i: Question, a: Answer, relay: string): string {
	const flat = (s: string) => s.replace(/\s+/g, " ").trim();
	return [
		`Steward, relaying ${principal()}'s answer from the decision queue (item ${i.id}; Chamberlain sent it the moment they answered).`,
		`Question: ${flat(i.title)}`,
		`Their choice: ${flat(a.label)}`,
		a.note ? `Their note: ${a.note}` : "",
		`What to do: ${relay}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** What a direction's answer says in place of an option's label (the wake and the record carry these words). */
export const DIRECTION_LABEL = "direction, no option chosen";
export const DISMISSED_LABEL = "dismissed";
const itemLines = (i: Question) => [
	`item: ${i.id}`,
	`question: ${i.title}`,
	`thread: ${i.thread}${i.threadId ? ` (${i.server}, ${i.threadId})` : ` (${i.server})`}`,
];

/** Pure: an answer with no option chosen. A direction needs its note (the caller checks); both choose `-1`, and neither saves a ruling. */
export function plainAnswer(kind: AnswerKind, id: string, note: string | undefined, t: string): Answer {
	return {
		choice: -1,
		label: kind === "direction" ? DIRECTION_LABEL : DISMISSED_LABEL,
		...(note ? { note } : {}),
		by: "page",
		t,
		deliveryId: answerDeliveryId(id),
		kind,
	};
}

/** The wake for a direction: the Steward reads the note and acts on it. It names the item, says no option was chosen, and carries the note. */
function directionWake(i: Question, a: Answer): string {
	const lines = [
		...itemLines(i),
		`choice: ${DIRECTION_LABEL}: they picked none of the options and wrote you a note instead`,
		`note: ${a.note ?? "none"}`,
		"ruling: none saved; this direction settles this item only",
		"route: to you, never straight to the thread: you read the note and act on it",
	];
	return answerWakeText(i.id, lines.join("\n"));
}

/** The wake for a dismissal: short, and not an answer. The Steward stops tracking the item. */
function dismissWake(i: Question, a: Answer): string {
	const lines = [
		...itemLines(i),
		"dismissed: they said this is already handled or no longer needed. It is not an answer and settles nothing, so no ruling and no precedent. Stop tracking it.",
		a.note ? `note: ${a.note}` : "note: none",
	];
	return dismissedWakeText(i.id, lines.join("\n"));
}

export function answerWake(i: Question, a: Answer, why?: StewardWhy): string {
	if (a.kind === "direction") return directionWake(i, a);
	if (a.kind === "dismissed") return dismissWake(i, a);
	const chosen = i.options[a.choice];
	const relay = chosen?.label === a.label && chosen.route === "thread" ? chosen.relay : undefined;
	const lines = [
		`item: ${i.id}`,
		`question: ${i.title}`,
		`thread: ${i.thread}${i.threadId ? ` (${i.server}, ${i.threadId})` : ` (${i.server})`}`,
		`choice: ${a.choice + 1}. ${a.label}${a.by === "batch" ? " (accepted with every recommendation)" : ""}`,
		a.note ? `note: ${a.note}` : "note: none",
		a.ruling
			? `ruling: saved as ${a.ruling.id}, in force and confirmed by ${principal()}: ${a.ruling.decides}`
			: "ruling: none saved; this answer settles this item only",
		...(why ? [`route: to you, not straight to the thread (${why}): ${WHY_TEXT[why]}`] : []),
		...(why && relay ? [`relay text for this option: ${relay}`] : []),
	];
	return answerWakeText(i.id, lines.join("\n"));
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

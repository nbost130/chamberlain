/**
 * The decision queue. A question is an item of the one item system (source "queue", kind "question", key its Q-id) with
 * its answer flow attached: the one-wake claim (`claims`), the direct send to its thread (`relays`) and its evidence
 * rows. ask.ts, the page and the daemon all write through the Store, so none rewrites another's lines. What a question
 * looks like now is composed from those rows (`questionStates`).
 */
import { randomBytes } from "node:crypto";
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
	{
		claim,
		ev,
		relay,
	}: { claim: ClaimRecord | undefined; ev: EvidenceRow[] | undefined; relay: RelayRecord | undefined },
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
		out.set(
			i.dedupKey,
			stateOf(i, { claim: claims.get(i.dedupKey), ev: evidence.get(i.dedupKey), relay: relays.get(i.dedupKey) }, now),
		);
	return out;
}
export const getQuestion = (store: Store, id: string): QuestionState | undefined => questionStates(store).get(id);

/** Sets a question aside: it stays open and answerable, and sinks to the end of the ranking. */
export function notNow(store: Store, id: string, t = new Date().toISOString()) {
	store.items.acknowledge(QUEUE, id, Date.parse(t), { notNowAt: t });
}

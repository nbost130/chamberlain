/** Ordering the queue, which items a batch may answer, and the wake an answer becomes. */
import { principal } from "./config.ts";
import { answerWakeText, dismissedWakeText } from "./messages.ts";
import {
	type Answer,
	type AnswerKind,
	isUrgent,
	type Kind,
	QUEUE,
	type Question,
	type QuestionState,
} from "./questions.ts";
import type { Store } from "./store.ts";

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
export function threadRelayMessage(i: Question, a: Answer, relay: string): string {
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

/**
 * How an idle-parents finding reads in the wake: ask / wait tags, title clip, excerpt. Kept apart so idle-parents.ts stays
 * under the file line limit.
 */
import type { Classified } from "./classifier/classify.ts";
import type { IdleThread } from "./idle-select.ts";
import { waitClosing } from "./wait-phrases.ts";

/** How much of the last message a finding carries. The tail, because that is where a question sits. */
export const EXCERPT_CHARS = 300;

/** Pure: the last of a message, whitespace collapsed, cut at the start so the end (where an ask is) stays. */
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `…${flat.slice(-max).toWellFormed()}` : flat;
}

const clipTitle = (s: string) => (s.length > 80 ? `${s.slice(0, 79).toWellFormed()}…` : s);

/** Pure: `[WAITING: …]` when a wait phrase names what is owed (Pilot B/C closings), else empty. */
function waitTag(t: Pick<IdleThread, "lastMessage" | "waitingOn">): string {
	if (t.waitingOn) return `[WAITING: ${t.waitingOn}] `;
	const w = waitClosing(t.lastMessage);
	return w ? `[WAITING: ${w.awaiting}] ` : "";
}

/** Pure: the tag for a wait or ask closing: wait first, else `[ASKING]`. */
function idleTag(t: Pick<IdleThread, "looksLikeAsk" | "lastMessage" | "waitingOn">): string {
	return waitTag(t) || (t.looksLikeAsk ? "[ASKING] " : "");
}

/** Pure: how one idle thread reads in the wake. */
export const idleText = (t: IdleThread) =>
	`${idleTag(t)}thread "${clipTitle(t.title)}" on ${t.server} (threadId ${t.threadId}), idle ${t.idleMinutes} min. Last message: ${excerptOf(t.lastMessage)}`;

/** Pure: the tag a live classification puts first. */
export const classTag = (c: Pick<Classified, "action" | "reasons">) =>
	`[${c.action.toUpperCase()}${c.reasons.map((r) => ` ${r.id} ${r.p.toFixed(2)}`).join(",")}]`;

/** Pure: how a thread the classifier sorted reads in a live wake. Wait labels stay beside escalate/nudge. */
export const classifiedText = (t: IdleThread, c: Classified | undefined) =>
	c && (c.action === "escalate" || c.action === "nudge")
		? `${classTag(c)} ${waitTag(t)}thread "${clipTitle(t.title)}" on ${t.server} (threadId ${t.threadId}), idle ${t.idleMinutes} min. Last message: ${excerptOf(t.lastMessage)}`
		: idleText(t);

const DIGEST_TITLES = 12;

/** Pure: the digest line for the threads a live classifier called settled. */
export const digestText = (settled: readonly IdleThread[]) => {
	const shown = settled
		.slice(0, DIGEST_TITLES)
		.map((t) => `"${clipTitle(t.title)}" on ${t.server}`)
		.join(", ");
	const more = settled.length > DIGEST_TITLES ? `, and ${settled.length - DIGEST_TITLES} more` : "";
	return `${settled.length} idle thread${settled.length === 1 ? "" : "s"} look${settled.length === 1 ? "s" : ""} finished (the classifier's settle; not reported one by one): ${shown}${more}.`;
};

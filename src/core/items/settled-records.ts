/** Settled records: the records the queue, the rulings and the decisions log offer to match against. */

import { readRulings } from "../ops/rulings.ts";
import { isExpired } from "../ops/rulings-expiry.ts";
import type { Store } from "../store/store.ts";
import { type QuestionState, questionStates } from "./questions.ts";
import { redactSecretFields } from "./secret-fields.ts";
import type { SettledRecord } from "./settled.ts";
import { oneLine } from "./settled-text.ts";

/** What a settled question's answer says on one line: its option or direction, its note and any ruling it saved. */
function queueAnswerText(q: QuestionState): string {
	if (q.status === "answered-on-card") return "answered on its question card";
	const note = q.answer?.note ? ` (${oneLine(q.answer.note, 70)})` : "";
	const ruling = q.answer?.ruling ? `, saved ${q.answer.ruling.id}` : "";
	return `answered "${q.answer?.label ?? "?"}"${note}${ruling}`;
}

/** A decline is an option convention; dismissal is a separate queue action. */
function isDecline(q: QuestionState): boolean {
	return (
		q.answer?.kind === undefined &&
		/^(?:no(?:$|[,.!])|decline\b|reject\b|drop\b|pass$)/i.test(q.answer?.label.trim() ?? "")
	);
}

const closedAt = (q: QuestionState) => q.dismissal?.t ?? q.answer?.t ?? q.createdAt;

function canMatch(q: QuestionState, ideaDeclineSince?: number): boolean {
	if (q.status === "open") return false;
	const ideaLookup = q.kind === "idea" && ideaDeclineSince !== undefined;
	if (ideaLookup && (q.status === "dismissed" || isDecline(q))) return Date.parse(closedAt(q)) >= ideaDeclineSince;
	return q.status !== "dismissed";
}

export function queueRecords(store: Store, ideaDeclineSince?: number): SettledRecord[] {
	const out: SettledRecord[] = [];
	for (const q of questionStates(store).values()) {
		if (!canMatch(q, ideaDeclineSince)) continue;
		// A secret's title, context and details never enter matching or refusal text.
		const safe = redactSecretFields(q);
		const date = String(closedAt(q) ?? "").slice(0, 10);
		const answer = q.status === "dismissed" ? "dismissed" : queueAnswerText(q);
		out.push({
			source: "queue",
			date,
			id: q.id,
			answer,
			title: safe.title,
			text: `${safe.title}\n${safe.context ?? ""}\n${safe.details ?? ""}\n${safe.blocks ?? ""}`,
			thread: q.thread,
		});
	}
	return out;
}

/** The rulings in force at `nowMs`: status in-force and not past its expiry. Proposed, expired, superseded and retired rulings settle nothing. */
export function rulingRecords(store: Store, nowMs: number): SettledRecord[] {
	return readRulings(store)
		.filter((r) => r && typeof r === "object" && r.status === "in-force" && !isExpired(r, nowMs))
		.map((r) => ({
			source: "ruling" as const,
			date: String(r.confirmedAt ?? r.date ?? "").slice(0, 10),
			id: r.id,
			answer: `in force: ${oneLine(r.decides)}`,
			title: r.decides,
			text: `${r.words}\n${r.decides}`,
			...(r.item ? { item: r.item } : {}),
		}));
}

export function decisionRecords(store: Store): SettledRecord[] {
	return store.decisions
		.list()
		.filter((d) => d && typeof d === "object" && typeof d.t === "string" && typeof d.decision === "string")
		.map((d) => ({
			source: "decision" as const,
			date: d.t.slice(0, 10),
			id: `D@${d.t.slice(0, 16)}`,
			answer: `decided: ${oneLine(d.decision)}${d.ruling ? ` (${oneLine(d.ruling, 40)})` : ""}`,
			title: d.decision,
			text: `${d.decision}\n${d.ruling ?? ""}\n${d.ref ?? ""}`,
			thread: d.thread,
		}));
}

/**
 * Who answered a decision, read from Chamberlain's own record and nowhere else. A thread that receives a relayed answer
 * can run `chamberlain decisions verify <id>` and trust the verdict, because the text of a message proves nothing: anyone
 * can write "Nathan approved". Only a claim owned by the decision page (the principal's click on the page, with the page
 * key or the view key) counts; a claim made by anything else, a dismissal, a direction, a card answered in T3, an item
 * with no answer, or an unknown id verifies as nobody.
 */
import { principal } from "../config/config.ts";
import type { Store } from "../store/store.ts";
import { type Answer, getQuestion, type QuestionState } from "./questions.ts";
import { PAGE, readClaim } from "./questions-claim.ts";

export type Provenance = {
	id: string;
	/** "principal" only for an option the principal chose on the decision page; otherwise "none", with `why`. */
	answeredBy: "principal" | "none";
	why?: string;
	/** Where it was answered: the decision page, with the key it proved (page or view). */
	via?: "decision page";
	key?: "page" | "view";
	/** "page": chosen by hand; "batch": accepted with every recommendation (still the principal's click). */
	by?: "page" | "batch";
	answeredAt?: string;
	choice?: string;
	note?: string;
	question?: string;
	server?: string;
	threadId?: string;
};

const none = (id: string, why: string): Provenance => ({ id, answeredBy: "none", why });

/** Pure: is this stored answer a whole record of a choice made on the page: a key, a who, a time, and exactly one of the question's options? */
function malformed(q: QuestionState, a: Answer): string | undefined {
	if (a.key !== "page" && a.key !== "view")
		return "the record names no key the answer was made with, so it is not the principal's";
	if (a.by !== "page" && a.by !== "batch") return "the record does not say how the answer was made";
	if (typeof a.t !== "string" || Number.isNaN(Date.parse(a.t))) return "the record has no time";
	const chosen = Number.isInteger(a.choice) ? q.options[a.choice] : undefined;
	if (!chosen || chosen.label !== a.label) return "the answer is not exactly one of the question's options";
	return undefined;
}

/** Pure: what the record says about who answered. `owner` is the claim's owner, undefined when nothing claimed the item. */
function provenanceOf(id: string, q: QuestionState | undefined, owner: string | undefined): Provenance {
	if (!q) return none(id, "no such decision");
	if (q.status === "answered-on-card") return none(id, "answered on its question card in T3, not on the decision page");
	if (q.status === "dismissed") return none(id, "dismissed: no answer was given");
	const a: Answer | undefined = q.answer;
	if (!a || owner === undefined) return none(id, "not answered");
	if (owner !== PAGE) return none(id, `the answer was made by "${owner}", not on the decision page`);
	if (a.kind) return none(id, "a direction, not a chosen option");
	const bad = malformed(q, a);
	if (bad) return none(id, bad);
	return {
		id,
		answeredBy: "principal",
		via: "decision page",
		key: a.key as "page" | "view",
		by: a.by,
		answeredAt: a.t,
		choice: a.label,
		...(a.note ? { note: a.note } : {}),
		question: q.title,
		server: q.server,
		...(q.threadId ? { threadId: q.threadId } : {}),
	};
}

/** Reads one decision's provenance from the store. Reads only. */
export const readProvenance = (store: Store, id: string): Provenance =>
	provenanceOf(id, getQuestion(store, id), readClaim(store, id)?.owner);

/** What a thread says it was told, to check against the record. Both are required: a check that names neither proves nothing. */
export type Expect = { choice: string; threadId: string };

/** Pure: does the record bear out the claim? ok only for a principal answer whose choice and thread both match what was given. */
export function verify(p: Provenance, expect: Expect): { ok: boolean; line: string } {
	if (p.answeredBy !== "principal")
		return { ok: false, line: `unverified: ${p.id}: ${p.why ?? "not the principal's answer"}` };
	if (expect.choice !== p.choice)
		return { ok: false, line: `unverified: ${p.id}: the record's choice is "${p.choice}", not "${expect.choice}"` };
	if (p.threadId === undefined || expect.threadId !== p.threadId)
		return {
			ok: false,
			line: `unverified: ${p.id}: the record's thread is ${p.threadId ?? "none"}, not ${expect.threadId}`,
		};
	return {
		ok: true,
		line: `verified: ${p.id}: ${principal()} chose "${p.choice}" on the decision page (key ${p.key}) at ${p.answeredAt}`,
	};
}

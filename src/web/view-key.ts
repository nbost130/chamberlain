/**
 * What the VIEW key may do (`secrets/view-key`, the one key a Decisions post carries: a post is copied into the thread). One explicit
 * allowlist, named here and nowhere derived: three reads, a plain answer, the four ways to settle, put off or bring back a question that
 * the pinned Decisions view offers in place (snooze, un-snooze, direction, dismiss), the answer to a QUESTION card waiting in another thread
 * (`CARD_ANSWER_PATH`, below: never an approval, goal, secret or link), a view-only dismiss of any mirrored card (`CARD_DISMISS_PATH`: hides
 * it from the views; never answers or retires the thread request), and two GETs that are not the API:
 *   - `GET /open/<server>/<threadId>`, the "Open the thread" link (a redirect to the thread's app link, made by the linker from the path, never
 *     from the request; it signs nothing in and sets no cookie, so `?k=<view key>` on it opens the thread and does nothing else; the Decisions
 *     view's thread link is the one link out that carries the key);
 *   - `GET /evidence/<id>/<name>`, one evidence file the question lists, for a question the view key's own reads already show it (the open and
 *     snoozed queue, the recent answers: `viewKeyReadable` in ./app-routes.ts). An `<img>` or `<video>` cannot send a header, so `?k=<view key>`
 *     works here too, and it too signs nothing in and sets no cookie. A name the question does not list, another question's folder, a question
 *     the reads do not show, or any path outside the folder is refused (./evidence.ts resolveEvidence, ./app-pages.ts). The Decisions view showed
 *     its evidence this way until 3b28f2b swapped the page key in posts for this one and left evidence off its list.
 * Every other route refuses the view key, whatever its Origin: not-now, batch accept, every ruling action, an approval's or goal's answer and the
 * confirmation step, one item's own read, pages.
 *
 * Three things use it, and nothing else decides what the view key may do:
 *   - `viewKeyVerdict`: the request's route and method against the list (the origin gate and the key gate in ./app.ts);
 *   - `authorityOf`: who a request is, as the second lock inside each write route sees it;
 *   - `mayDo`: whether that authority may do one of the write actions (the lock inside the route).
 * The answer is held to its field list too (`VIEW_KEY_ANSWER_FIELDS`, checked in ./app-answer.ts): the view key's answer is a choice and nothing else.
 * `inlineVerdict` (./app.ts) is the OLD list, three reads and a plain answer, and still holds for the page key from a frame or with no Origin.
 */

import type { KeyUsed } from "../core/items/questions.ts";

/** The reads the view key may make. */
export const VIEW_KEY_READS: ReadonlySet<string> = new Set(["/api/queue", "/api/recent", "/api/rulings"]);
/** The writes the view key may make, each on one queue item: `POST /api/items/<id>/<action>`. */
export const VIEW_KEY_WRITES = ["answer", "snooze", "unsnooze", "direction", "dismiss"] as const;
type ViewKeyWrite = (typeof VIEW_KEY_WRITES)[number];

/** The one field a view-key answer may carry: the option chosen. Not a note (a note is a Direction, or written on the full page), not a ruling field. */
export const VIEW_KEY_ANSWER_FIELDS: ReadonlySet<string> = new Set(["choice"]);

/** `/open/<server>/<threadId>`: sends a device on to the thread's link (./thread-links.ts). The one page-shaped route the view key may GET. */
export const OPEN_PATH = /^\/open\/[^/]+\/[^/]+$/;

/** `/evidence/<id>/<name>`: one of a question's evidence files (./evidence.ts). The other GET the view key may make that is not the API. */
export const EVIDENCE_PATH = /^\/evidence\/Q-[a-z0-9]{4,16}\/[^/]+$/;

const ITEM_WRITE = new RegExp(`^/api/items/Q-[a-z0-9]{4,16}/(${VIEW_KEY_WRITES.join("|")})$`);

/**
 * `POST /api/cards/<id>/answer`: a card waiting in another thread, answered from the Decisions view. Only a QUESTION card (`VIEW_KEY_CARD_TYPES`),
 * which takes no confirmation; an approval, a goal proposal, a secret and a machine link are refused to the view key inside the route
 * (./view-key-cards.ts, and again where the answer is sent: ./waiting.ts answerCard `only`), and `/confirm` (the approvals' first step) is not on
 * this list at all. This is a NEW permission, granted on purpose (Nathan, 2026-11-15): it resolves a builder's pending question request in T3 as
 * the principal's answer (`runtime-request.respond`), which no item answer reaches. Its harm is of the kind the view key already carried: it
 * answers every Chamberlain question for the principal, `only-you` ones included, and a thread-routed option already reaches a thread as the
 * principal's words. What runs or commits to something (an approval, a goal) stays the full page's, behind its server-checked confirmation.
 */
const CARD_ANSWER_PATH = /^\/api\/cards\/C-[0-9a-f]{12}\/answer$/;
/**
 * `POST /api/cards/<id>/dismiss`: hide a mirrored waiting card from the views only (Nathan, 2026-11-15 #68 / B2). Every kind: approval,
 * goal, secret, link, question. Never answers or retires the thread request; a new request id shows again.
 */
const CARD_DISMISS_PATH = /^\/api\/cards\/C-[0-9a-f]{12}\/dismiss$/;
/** The kinds of card the view key may answer: a question card. Never an approval or goal (they run or commit to something), a secret or a link. */
export const VIEW_KEY_CARD_TYPES: ReadonlySet<string> = new Set(["question"]);
/** The fields a view-key card answer may carry: the option chosen and the card's fingerprint as the view showed it. No confirmation, no note. */
export const VIEW_KEY_CARD_FIELDS: ReadonlySet<string> = new Set(["choice", "sig"]);

type ViewKeyVerdict =
	| "read"
	| "open"
	| "evidence"
	| ViewKeyWrite
	| "card-answer"
	| "card-dismiss"
	| "preflight"
	| "refuse";

/** Pure: the card route on the view key's list, if this pathname is one. */
function cardVerdict(pathname: string): "card-answer" | "card-dismiss" | undefined {
	if (CARD_ANSWER_PATH.test(pathname)) return "card-answer";
	if (CARD_DISMISS_PATH.test(pathname)) return "card-dismiss";
	return undefined;
}

/** Pure: a request's route against the view key's list. `preflight` is an OPTIONS for a route on it (it grants nothing and carries no key). */
export function viewKeyVerdict(method: string, pathname: string): ViewKeyVerdict {
	if (method === "GET") {
		if (VIEW_KEY_READS.has(pathname)) return "read";
		if (EVIDENCE_PATH.test(pathname)) return "evidence";
		return OPEN_PATH.test(pathname) ? "open" : "refuse";
	}
	const write = ITEM_WRITE.exec(pathname)?.[1] as ViewKeyWrite | undefined;
	const card = cardVerdict(pathname);
	if (method === "POST") return write ?? card ?? "refuse";
	if (method === "OPTIONS") return VIEW_KEY_READS.has(pathname) || write || card ? "preflight" : "refuse";
	return "refuse";
}

/**
 * Who a request is, once its key is checked. `full` is everything the page can do (the cookie, a link, the page key from the page's own
 * origin); `view` is the view key's list above; `restricted` is the page key from a null-origin frame or with no Origin: the old inline
 * list, three reads and a plain answer.
 */
export type Authority = "full" | "view" | "restricted";

/** Pure: the authority a request has. `restricted` is whether it is not full (a frame, or a key that is not the page's own from its own origin). */
export function authorityOf(restricted: boolean, viewKeyProved: boolean): Authority {
	if (!restricted) return "full";
	return viewKeyProved ? "view" : "restricted";
}

/** The key to record for an authority: the view key's own writes say `view`; every other authority acted with the page's key. */
export const keyUsed = (a: Authority): KeyUsed => (a === "view" ? "view" : "page");

/** Pure: whether an authority may do a write action on an item. Full may do every one; the view key only its list; a restricted page key none but the plain answer. */
export function mayDo(a: Authority, action: string): boolean {
	if (a === "full") return true;
	if (a === "view") return (VIEW_KEY_WRITES as readonly string[]).includes(action);
	return action === "answer";
}

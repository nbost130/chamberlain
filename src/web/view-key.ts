/**
 * What the VIEW key may do (`secrets/view-key`, the one key a Decisions post carries: a post is copied into the thread). One explicit
 * allowlist, named here and nowhere derived: three reads, a plain answer, and the four ways to settle, put off or bring back a question that
 * the pinned Decisions view offers in place (snooze, un-snooze, direction, dismiss). Every other route refuses the view key, whatever its
 * Origin: not-now, batch accept, every ruling action, the question-card and approval routes, one item's own read, evidence, pages.
 *
 * Three things use it, and nothing else decides what the view key may do:
 *   - `viewKeyVerdict`: the request's route and method against the list (the origin gate and the key gate in ./app.ts);
 *   - `authorityOf`: who a request is, as the second lock inside each write route sees it;
 *   - `mayDo`: whether that authority may do one of the write actions (the lock inside the route).
 * The answer is held to its field list too (`VIEW_KEY_ANSWER_FIELDS`, checked in ./app-answer.ts): the view key's answer is a choice and nothing else.
 * `inlineVerdict` (./app.ts) is the OLD list, three reads and a plain answer, and still holds for the page key from a frame or with no Origin.
 */

import type { KeyUsed } from "../core/questions.ts";

/** The reads the view key may make. */
export const VIEW_KEY_READS: ReadonlySet<string> = new Set(["/api/queue", "/api/recent", "/api/rulings"]);
/** The writes the view key may make, each on one queue item: `POST /api/items/<id>/<action>`. */
export const VIEW_KEY_WRITES = ["answer", "snooze", "unsnooze", "direction", "dismiss"] as const;
export type ViewKeyWrite = (typeof VIEW_KEY_WRITES)[number];

/** The one field a view-key answer may carry: the option chosen. Not a note (a note is a Direction, or written on the full page), not a ruling field. */
export const VIEW_KEY_ANSWER_FIELDS: ReadonlySet<string> = new Set(["choice"]);

const ITEM_WRITE = new RegExp(`^/api/items/Q-[a-z0-9]{4,16}/(${VIEW_KEY_WRITES.join("|")})$`);

/** Pure: a request's route against the view key's list. `preflight` is an OPTIONS for a route on it (it grants nothing and carries no key). */
export function viewKeyVerdict(method: string, pathname: string): "read" | ViewKeyWrite | "preflight" | "refuse" {
	if (method === "GET") return VIEW_KEY_READS.has(pathname) ? "read" : "refuse";
	const write = ITEM_WRITE.exec(pathname)?.[1] as ViewKeyWrite | undefined;
	if (method === "POST") return write ?? "refuse";
	if (method === "OPTIONS") return VIEW_KEY_READS.has(pathname) || write ? "preflight" : "refuse";
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

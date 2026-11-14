/** Reading the rulings: which are in force or expired now, how they render, and the decisions that cite them. */

import { type Clock, type Ruling, readRulings } from "./rulings.ts";
import { isExpired } from "./rulings-expiry.ts";
import type { Store } from "./store.ts";

// ---- reading ------------------------------------------------------------------------------------

/** Pure: the rulings in force at `nowMs`: status in-force and not past its `expires`. */
export const inForceNow = (list: Ruling[], nowMs: number = Date.now()) =>
	list.filter((r) => r.status === "in-force" && !isExpired(r, nowMs));

/** Pure: the rulings that are still marked in force but whose `expires` has passed. They count for nothing and are left to be retired. */
export const expiredNow = (list: Ruling[], nowMs: number = Date.now()) =>
	list.filter((r) => r.status === "in-force" && isExpired(r, nowMs));

/** Pure: the in-force rulings as the hand-off and every wake carry them, each with its ID. An expired one is left out. */
export function renderInForce(list: Ruling[], nowMs: number = Date.now()): string {
	return inForceNow(list, nowMs)
		.map(
			(r) =>
				`- ${r.id} (${r.date}): "${r.words}" -> ${r.decides}${r.expires ? ` [expires ${r.expires}]` : ""}${r.until ? ` [until ${r.until}]` : ""}${r.confirmed ? "" : " [unconfirmed: began as a card answer]"}`,
		)
		.join("\n");
}

/** Pure: one line naming the rulings past their expiry, so a reader of the hand-off does not act on one from memory. Empty when none. */
export function renderExpired(list: Ruling[], nowMs: number = Date.now()): string {
	const e = expiredNow(list, nowMs);
	return e.length
		? `Expired, NOT in force (do not act on them): ${e.map((r) => `${r.id} (expired ${r.expires})`).join(", ")}.`
		: "";
}

/** The rulings text for wakes: the in-force rulings with their IDs. Empty when none is in force. */
export const rulingsText = (store: Store, clock: Clock = Date.now): string =>
	renderInForce(readRulings(store), clock());

/** The rulings section of the hand-off: the in-force rulings, then the expired ones by id. */
export const rulingsBriefText = (store: Store, clock: Clock = Date.now): string => {
	const list = readRulings(store);
	return [renderInForce(list, clock()), renderExpired(list, clock())].filter(Boolean).join("\n");
};

export type Citation = { t: string; thread: string; decision: string };
/** Pure: how often each ruling was cited by ID in the decision log, with the newest citations first. */
export function citations(
	decisions: { t: string; thread: string; decision: string; rulingIds?: string[] }[],
): Map<string, Citation[]> {
	const out = new Map<string, Citation[]>();
	for (const d of decisions)
		for (const id of d.rulingIds ?? []) {
			const list = out.get(id) ?? [];
			list.push({ t: d.t, thread: d.thread, decision: d.decision });
			out.set(id, list);
		}
	for (const list of out.values()) list.sort((a, b) => b.t.localeCompare(a.t));
	return out;
}

/** Pure: the ruling IDs a decided.ts citation leads with ("R3", "R3, R7: why"). Free text gives none. */
export function citedIds(ruling: string): string[] {
	const m = ruling.trim().match(/^(R\d+(?:\s*[,+&]\s*R\d+)*)(?=$|[\s:;,.)-])/);
	const ids = m?.[1];
	return ids ? [...new Set(ids.split(/\s*[,+&]\s*/))] : [];
}

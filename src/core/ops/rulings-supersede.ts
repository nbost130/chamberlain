/** Finding a held ruling again, and what a ruling that replaces others does to them. */

import type { Recorded, Ruling, RulingChange, RulingOpts } from "./rulings.ts";
import { isExpired, iso } from "./rulings-expiry.ts";

const sameText = (a: string, b: string) =>
	a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The ruling already held with these exact words and this exact decision, if any: one that is still live (proposed or in
 * force, and not expired). A retired or expired ruling can be said again as a new one.
 */
export function findHeld(
	list: Ruling[],
	words: string,
	decides: string,
	nowMs: number = Date.now(),
): Ruling | undefined {
	return list.find(
		(r) => r.status !== "retired" && !isExpired(r, nowMs) && sameText(r.words, words) && sameText(r.decides, decides),
	);
}

/** In place: one more line in the ruling's history, which is started if it has none. */
export function logChange(r: Ruling, entry: RulingChange) {
	const history = r.history ?? [];
	history.push(entry);
	r.history = history;
}

/** In place: every ruling `r` supersedes leaves force, pointing at `r`. A missing id is an error; one already retired is left as it is. */
export function applySupersedes(list: Ruling[], r: Ruling, nowMs: number) {
	const t = iso(nowMs);
	for (const id of r.supersedes ?? []) {
		const old = list.find((x) => x.id === id);
		if (!old) throw Error(`supersedes ${id}: no such ruling`);
		if (old.id === r.id || old.status === "retired") continue;
		logChange(old, { t, what: `superseded by ${r.id}` });
		old.status = "retired";
		old.retiredAt = t;
		old.retiredHow = "superseded";
		old.supersededBy = r.id;
		old.retiredWhy = `replaced by ${r.id}`;
	}
}

/** Does a held ruling still need the principal's word to count: a proposal, or an in-force card answer they never confirmed? */
const needsPromote = (r: Ruling) => r.status === "proposed" || !r.confirmed;

/** In place: a held proposal (or unconfirmed card answer) becomes in force and confirmed because the principal has now said the same thing. */
export function promote(list: Ruling[], r: Ruling, how: string, nowMs: number) {
	if (!needsPromote(r)) return;
	logChange(r, { t: iso(nowMs), what: how });
	r.status = "in-force";
	r.confirmed = true;
	r.confirmedAt = iso(nowMs);
	applySupersedes(list, r, nowMs);
}

/** In place: a restatement's expiry or until is added to the held ruling when it has none; one it already has is kept. */
export function adopt(r: Ruling, o: RulingOpts, nowMs: number) {
	const added = (["expires", "until"] as const).filter((k) => o[k] && !r[k]);
	for (const k of added) r[k] = o[k];
	if (added.length) logChange(r, { t: iso(nowMs), what: `${added.join(" and ")} added on a restatement` });
}

/**
 * In place: the ids a restatement names in `supersedes` that the held ruling does not yet replace are added to its `supersedes`,
 * and when it is in force they leave force now, in the caller's write. A proposal retires them when it is confirmed. The ids added.
 */
export function mergeSupersedes(list: Ruling[], held: Ruling, o: RulingOpts, nowMs: number): string[] {
	const added = newSupersedes(held, o);
	if (!added.length) return [];
	held.supersedes = [...(held.supersedes ?? []), ...added];
	logChange(held, { t: iso(nowMs), what: `supersedes ${added.join(", ")} added on a restatement` });
	if (held.status === "in-force") applySupersedes(list, { ...held, supersedes: added }, nowMs);
	return added;
}

export const repeated = (held: Ruling, added: string[]): Recorded => ({
	...held,
	duplicate: true as const,
	...(added.length ? { supersedesAdded: added } : {}),
});

export function checkSupersedes(list: Ruling[], o: RulingOpts) {
	for (const id of o.supersedes ?? [])
		if (!list.some((x) => x.id === id)) throw Error(`supersedes ${id}: no such ruling`);
}

/**
 * Pure: a cycle in the supersede graph, as the ids around it with the first repeated at the end (R1 → R2 → R1), or undefined.
 * The edges are every live ruling's `supersedes` (proposed and in force: a proposal's edges take effect when it is confirmed), plus
 * `adds` from `from` when given. A retired ruling's edges are spent, so they are not counted.
 */
export function supersedeCycle(list: Ruling[], from?: string, adds: string[] = []): string[] | undefined {
	const edges = new Map<string, string[]>();
	for (const r of list) if (r.status !== "retired") edges.set(r.id, [...(r.supersedes ?? [])]);
	if (from) edges.set(from, [...(edges.get(from) ?? []), ...adds]);
	const done = new Set<string>();
	const walk = (id: string, path: string[]): string[] | undefined => {
		const at = path.indexOf(id);
		if (at >= 0) return [...path.slice(at), id];
		if (done.has(id)) return undefined;
		for (const next of edges.get(id) ?? []) {
			const c = walk(next, [...path, id]);
			if (c) return c;
		}
		done.add(id);
		return undefined;
	};
	for (const id of from ? [from] : edges.keys()) {
		const c = walk(id, []);
		if (c) return c;
	}
	return undefined;
}

/** Throws, naming it, when `held` superseding `adds` too would supersede itself or close a cycle. Changes nothing. */
export function checkNoCycle(list: Ruling[], held: Ruling, adds: string[]) {
	if (adds.includes(held.id)) throw Error(`supersedes ${held.id}: a ruling cannot supersede itself`);
	const c = supersedeCycle(list, held.id, adds);
	if (c) throw Error(`supersedes ${adds.join(", ")} on ${held.id} would make a supersede cycle: ${c.join(" → ")}`);
}

/** The ids `o` names that `held` does not yet supersede. */
export const newSupersedes = (held: Ruling, o: RulingOpts) =>
	(o.supersedes ?? []).filter((id) => !(held.supersedes ?? []).includes(id));

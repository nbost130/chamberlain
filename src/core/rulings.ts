/**
 * Standing rulings with IDs (R1, R2, ...), in the database's `rulings` table.
 *
 * A ruling is in force only when its status is "in-force". A proposal (the Steward's own reading of an answer) waits
 * for the principal to confirm it on the rulings page. A rule the principal stated in chat is in force from the start.
 */
import type { Store } from "./store.ts";

export type RulingStatus = "in-force" | "proposed" | "retired";
export type RulingSource = "chat" | "card";
export type RulingChange = { t: string; what: string; from?: string };
export type Ruling = {
	id: string;
	date: string;
	words: string;
	decides: string;
	source: RulingSource;
	status: RulingStatus;
	confirmed: boolean;
	confirmedAt?: string;
	retiredAt?: string;
	/** Why it left force: "retired" by the principal, or "only this once" when it settled one case and stands for nothing more. */
	retiredHow?: "retired" | "only this once";
	/** The queue item it came from, when it was saved while answering one. */
	item?: string;
	history?: RulingChange[];
};

export const readRulings = (store: Store): Ruling[] => store.rulings.list();

/**
 * A read-modify-write in one transaction, so ruling.ts and the page can't lose each other's writes: whatever `fn` changes
 * in the list is saved, and nothing else is touched.
 */
export function updateRulings<T>(store: Store, fn: (list: Ruling[]) => T): T {
	return store.tx(() => {
		const list = store.rulings.list();
		const before = new Map(list.map((r) => [r.id, JSON.stringify(r)]));
		const out = fn(list);
		for (const r of list) if (before.get(r.id) !== JSON.stringify(r)) store.rulings.save(r);
		return out;
	});
}

export const nextId = (list: Ruling[]) => `R${list.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1}`;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

// ---- changes ------------------------------------------------------------------------------------

/** The Steward's ruling from a card answer or its own reading: a proposal, never in force until the principal confirms it. */
export function propose(store: Store, words: string, decides: string, item?: string): Ruling {
	return updateRulings(store, (list) => {
		const r: Ruling = { id: nextId(list), date: today(), words, decides, source: "card", status: "proposed", confirmed: false, ...(item ? { item } : {}), history: [{ t: now(), what: "proposed by the Steward" }] };
		list.push(r);
		return r;
	});
}

/** Pure: an in-force ruling, confirmed now, under the next free id of `list`. It is not saved. */
export function inForceRuling(list: Ruling[], words: string, decides: string, source: RulingSource, how: string, item?: string): Ruling {
	const t = now();
	return { id: nextId(list), date: today(), words, decides, source, status: "in-force", confirmed: true, confirmedAt: t, ...(item ? { item } : {}), history: [{ t, what: how }] };
}

/** A rule the principal stated in their own words in chat, or one they confirmed on the page: in force at once. */
export function addInForce(store: Store, words: string, decides: string, source: RulingSource, how: string, item?: string): Ruling {
	return updateRulings(store, (list) => {
		const r = inForceRuling(list, words, decides, source, how, item);
		list.push(r);
		return r;
	});
}

function change(store: Store, id: string, fn: (r: Ruling) => void): Ruling {
	return updateRulings(store, (list) => {
		const r = list.find((x) => x.id === id);
		if (!r) throw Error(`no ruling ${id}`);
		fn(r);
		return r;
	});
}

/** Confirm from the rulings page: in force, confirmed, optionally with new wording for what it decides. */
export const confirmRuling = (store: Store, id: string, decides?: string) => change(store, id, (r) => {
	if (r.status === "retired") throw Error(`${id} is retired`);
	const t = now();
	if (decides && decides.trim() && decides.trim() !== r.decides) { (r.history ??= []).push({ t, what: "wording edited on the page", from: r.decides }); r.decides = decides.trim(); }
	(r.history ??= []).push({ t, what: r.status === "proposed" ? "confirmed on the page (was a proposal)" : "confirmed on the page" });
	r.status = "in-force"; r.confirmed = true; r.confirmedAt = t;
});

/** New wording only. It changes nothing about whether the ruling is in force or confirmed. */
export const editRuling = (store: Store, id: string, decides: string) => change(store, id, (r) => {
	if (!decides.trim()) throw Error("empty wording");
	(r.history ??= []).push({ t: now(), what: "wording edited on the page", from: r.decides });
	r.decides = decides.trim();
});

export const retireRuling = (store: Store, id: string, how: "retired" | "only this once") => change(store, id, (r) => {
	if (r.status === "retired") return;
	const t = now();
	(r.history ??= []).push({ t, what: how === "only this once" ? "only this once: settled its case, stands for nothing more" : "retired on the page" });
	r.status = "retired"; r.retiredAt = t; r.retiredHow = how;
});

// ---- reading ------------------------------------------------------------------------------------

/** Pure: the in-force rulings as the hand-off and every wake carry them, each with its ID. */
export function renderInForce(list: Ruling[]): string {
	return list.filter((r) => r.status === "in-force").map((r) => `- ${r.id} (${r.date}): "${r.words}" -> ${r.decides}${r.confirmed ? "" : " [unconfirmed: began as a card answer]"}`).join("\n");
}

/** The rulings text for the hand-off and wakes: the in-force rulings with their IDs. Empty when none is in force. */
export const rulingsText = (store: Store): string => renderInForce(readRulings(store));

export type Citation = { t: string; thread: string; decision: string };
/** Pure: how often each ruling was cited by ID in the decision log, with the newest citations first. */
export function citations(decisions: { t: string; thread: string; decision: string; rulingIds?: string[] }[]): Map<string, Citation[]> {
	const out = new Map<string, Citation[]>();
	for (const d of decisions) for (const id of d.rulingIds ?? []) {
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
	return m ? [...new Set(m[1]!.split(/\s*[,+&]\s*/))] : [];
}

/**
 * Standing rulings with IDs (R1, R2, ...), in the database's `rulings` table.
 *
 * A ruling is in force only when its status is "in-force". A proposal (the Steward's own reading of an answer) waits
 * for the principal to confirm it on the rulings page. A rule the principal stated in chat is in force from the start.
 *
 * Hygiene, all in this layer so every writer gets it: recording the same words and decision twice gives the held ruling back; a
 * ruling can carry `expires` (read against a clock, never rewritten), `until` (a note) and `supersedes`; and one that leaves force
 * for a housekeeping reason keeps the reason. See "Rulings" in docs/ARCHITECTURE.md.
 */
import type { Store } from "./store.ts";

export type RulingStatus = "in-force" | "proposed" | "retired";
export type RulingSource = "chat" | "card";
export type RetiredHow = "retired" | "only this once" | "superseded" | "duplicate" | "expired" | "repeat";
/** The housekeeping reasons a ruling can leave force for. The database keeps them apart from the page's two (retired_reason, migration 11). */
export const HOUSEKEEPING: ReadonlySet<RetiredHow> = new Set<RetiredHow>(["superseded", "duplicate", "expired", "repeat"]);
/** What a new ruling may carry beyond its words and what it decides. */
export type RulingOpts = { expires?: string; until?: string; supersedes?: string[] };
/**
 * What recording returns: the ruling, flagged `duplicate` when it was already held (no new ruling was written), and on a repeat
 * the ids it named in `supersedes` that the held ruling did not yet replace (`supersedesAdded`): they were added to it.
 * A proposal that repeats a ruling already in force changes nothing (`alreadyInForce`): the ids it named that the ruling does not
 * replace are reported in `supersedesNotAdded`, because only the principal's word changes what is in force.
 */
export type Recorded = Ruling & { duplicate?: true; supersedesAdded?: string[]; alreadyInForce?: true; supersedesNotAdded?: string[] };
export type RulingChange = { t: string; what: string; from?: string };
/** The time every function here reads, in epoch milliseconds. Tests pass their own; nothing else changes how time is read. */
export type Clock = () => number;
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
	/**
	 * How it left force: "retired" by the principal, "only this once" when it settled one case and stands for nothing more,
	 * "superseded" by a newer ruling, "duplicate" of one that is held, "expired" past its time, or "repeat" of a rule the
	 * decision rights already state. The last four are housekeeping and carry retiredWhy (and supersededBy).
	 */
	retiredHow?: RetiredHow;
	/** One line on why it left force, for the rulings page. */
	retiredWhy?: string;
	/** The ruling that took its place (a duplicate points at the one kept). */
	supersededBy?: string;
	/** On a ruling that replaces older ones: their ids. They leave force when this one is in force. */
	supersedes?: string[];
	/**
	 * When it stops being in force: an ISO date (through the end of that day, UTC) or an ISO date-time with a zone. Past it,
	 * renderInForce leaves it out and the rulings page marks it expired. The record stays.
	 */
	expires?: string;
	/** A time bound only a person can judge ("until the V2 launch"): shown with the ruling, never enforced. */
	until?: string;
	/** The queue item it came from, when it was saved while answering one. */
	item?: string;
	history?: RulingChange[];
};

export const readRulings = (store: Store): Ruling[] => store.rulings.list();

/**
 * A read-modify-write in one transaction, so ruling.ts and the page can't lose each other's writes: whatever `fn` changes
 * in the list is saved, and nothing else is touched. The transaction takes the database's write lock when it starts, so the
 * read and the write of two processes never interleave: that is what makes every check made inside `fn` (is this already
 * held? does that id exist?) hold at the moment of the write.
 */
export function updateRulings<T>(store: Store, fn: (list: Ruling[]) => T): T {
	return store.tx(() => {
		const staged = stageRulings(store);
		const out = fn(staged.list);
		staged.commit();
		return out;
	});
}

/**
 * The rulings as a list to change in place, and a `commit` that saves only what changed. For a caller that is already inside a
 * transaction and must decide, between the change and the save, whether to keep it (the page's answer: its one claim comes first).
 */
export function stageRulings(store: Store): { list: Ruling[]; commit: () => void } {
	const list = store.rulings.list();
	const before = new Map(list.map((r) => [r.id, JSON.stringify(r)]));
	return { list, commit: () => { for (const r of list) if (before.get(r.id) !== JSON.stringify(r)) store.rulings.save(r); } };
}

export const nextId = (list: Ruling[]) => `R${list.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1}`;
const iso = (nowMs: number) => new Date(nowMs).toISOString();
const today = (nowMs: number) => iso(nowMs).slice(0, 10);

// ---- expiry, duplicates, supersession -------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A date-time must say its zone: without one it would mean different moments on different machines.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Pure: the UTC moment these calendar fields name, or NaN when they name none. JavaScript's Date rolls an impossible field into
 * the next one (February 30 becomes March 2, hour 24 the next day), so the moment is built and its fields read back: any that
 * differ from the input mean the input does not exist.
 */
function realUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	const t = new Date(0);
	t.setUTCFullYear(y, mo - 1, d);
	t.setUTCHours(h, mi, s, 0);
	const same = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
	return same ? t.getTime() : NaN;
}

/** Pure: is `expires` the shape of an ISO date or a date-time with a zone, whatever its numbers? */
export const expiresShape = (expires: string) => DATE.test(expires) || DATE_TIME.test(expires);

/**
 * The moment an `expires` value ends, in ms. A date alone runs through the end of that day (UTC). NaN if it isn't one: a value
 * of the wrong shape, or one whose date or time does not exist (2027-02-30, 2027-02-29, month 13, hour 24, an offset past 23:59).
 */
export function expiresAt(expires: string): number {
	const day = DATE.exec(expires);
	if (day) {
		const start = realUtc(Number(day[1]), Number(day[2]), Number(day[3]));
		return Number.isNaN(start) ? NaN : start + 86_400_000 - 1;
	}
	const m = DATE_TIME.exec(expires);
	if (!m) return NaN;
	const at = realUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
	const [oh, om] = [Number(m[9] ?? 0), Number(m[10] ?? 0)];
	if (Number.isNaN(at) || oh > 23 || om > 59) return NaN;
	const ms = m[7] ? Number(`${m[7].slice(1)}00`.slice(0, 3)) : 0;
	return at + ms - (m[8] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
}

/** Why `expires` can't be read, or undefined when it can: the wording every entry point (CLI, ask.ts, the page, the importer) uses. */
export function expiresProblem(expires: string): string | undefined {
	if (!Number.isNaN(expiresAt(expires))) return undefined;
	return expiresShape(expires)
		? `"${expires}" is not a real date and time: no such day, month, hour, minute, second or zone offset`
		: `must be an ISO date (2026-12-01) or date-time with a zone (2026-12-01T09:00:00Z), got "${expires}"`;
}

/** Pure: has this ruling's `expires` passed at `nowMs`? A ruling without one never does. One that can't be read counts as passed. */
export const isExpired = (r: Pick<Ruling, "expires">, nowMs: number = Date.now()) => Boolean(r.expires) && !(expiresAt(r.expires!) > nowMs);

/** A new ruling's options, checked: an unreadable or already-past expiry is refused, so a typo can't be recorded as a ruling. */
export function checkOpts(o: RulingOpts = {}, nowMs: number = Date.now()): RulingOpts {
	const out: RulingOpts = {};
	if (o.expires !== undefined) {
		const e = o.expires.trim();
		const problem = expiresProblem(e);
		if (problem) throw Error(`expires ${problem}`);
		if (isExpired({ expires: e }, nowMs)) throw Error(`expires ${e} is already past`);
		out.expires = e;
	}
	if (o.until?.trim()) out.until = o.until.trim();
	const ids = [...new Set((o.supersedes ?? []).map((x) => x.trim()).filter(Boolean))];
	for (const id of ids) if (!/^R\d+$/.test(id)) throw Error(`supersedes takes ruling ids like R32, got "${id}"`);
	if (ids.length) out.supersedes = ids;
	return out;
}

/** Pure: words compared as the principal would: case and runs of whitespace do not matter. */
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The ruling already held with these exact words and this exact decision, if any: one that is still live (proposed or in
 * force, and not expired). A retired or expired ruling can be said again as a new one.
 */
export function findHeld(list: Ruling[], words: string, decides: string, nowMs: number = Date.now()): Ruling | undefined {
	return list.find((r) => r.status !== "retired" && !isExpired(r, nowMs) && sameText(r.words, words) && sameText(r.decides, decides));
}

/** In place: every ruling `r` supersedes leaves force, pointing at `r`. A missing id is an error; one already retired is left as it is. */
function applySupersedes(list: Ruling[], r: Ruling, nowMs: number) {
	const t = iso(nowMs);
	for (const id of r.supersedes ?? []) {
		const old = list.find((x) => x.id === id);
		if (!old) throw Error(`supersedes ${id}: no such ruling`);
		if (old.id === r.id || old.status === "retired") continue;
		(old.history ??= []).push({ t, what: `superseded by ${r.id}` });
		old.status = "retired"; old.retiredAt = t; old.retiredHow = "superseded"; old.supersededBy = r.id; old.retiredWhy = `replaced by ${r.id}`;
	}
}

/** Does a held ruling still need the principal's word to count: a proposal, or an in-force card answer they never confirmed? */
const needsPromote = (r: Ruling) => r.status === "proposed" || !r.confirmed;

/** In place: a held proposal (or unconfirmed card answer) becomes in force and confirmed because the principal has now said the same thing. */
function promote(list: Ruling[], r: Ruling, how: string, nowMs: number) {
	if (!needsPromote(r)) return;
	(r.history ??= []).push({ t: iso(nowMs), what: how });
	r.status = "in-force"; r.confirmed = true; r.confirmedAt = iso(nowMs);
	applySupersedes(list, r, nowMs);
}

/** In place: a restatement's expiry or until is added to the held ruling when it has none; one it already has is kept. */
function adopt(r: Ruling, o: RulingOpts, nowMs: number) {
	const added = (["expires", "until"] as const).filter((k) => o[k] && !r[k]);
	for (const k of added) r[k] = o[k];
	if (added.length) (r.history ??= []).push({ t: iso(nowMs), what: `${added.join(" and ")} added on a restatement` });
}

/**
 * In place: the ids a restatement names in `supersedes` that the held ruling does not yet replace are added to its `supersedes`,
 * and when it is in force they leave force now, in the caller's write. A proposal retires them when it is confirmed. The ids added.
 */
function mergeSupersedes(list: Ruling[], held: Ruling, o: RulingOpts, nowMs: number): string[] {
	const added = newSupersedes(held, o);
	if (!added.length) return [];
	held.supersedes = [...(held.supersedes ?? []), ...added];
	(held.history ??= []).push({ t: iso(nowMs), what: `supersedes ${added.join(", ")} added on a restatement` });
	if (held.status === "in-force") applySupersedes(list, { ...held, supersedes: added }, nowMs);
	return added;
}

const repeated = (held: Ruling, added: string[]): Recorded => ({ ...held, duplicate: true as const, ...(added.length ? { supersedesAdded: added } : {}) });

function checkSupersedes(list: Ruling[], o: RulingOpts) {
	for (const id of o.supersedes ?? []) if (!list.some((x) => x.id === id)) throw Error(`supersedes ${id}: no such ruling`);
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
function checkNoCycle(list: Ruling[], held: Ruling, adds: string[]) {
	if (adds.includes(held.id)) throw Error(`supersedes ${held.id}: a ruling cannot supersede itself`);
	const c = supersedeCycle(list, held.id, adds);
	if (c) throw Error(`supersedes ${adds.join(", ")} on ${held.id} would make a supersede cycle: ${c.join(" → ")}`);
}

/** The ids `o` names that `held` does not yet supersede. */
const newSupersedes = (held: Ruling, o: RulingOpts) => (o.supersedes ?? []).filter((id) => !(held.supersedes ?? []).includes(id));

// ---- changes ------------------------------------------------------------------------------------

/**
 * The Steward's ruling from a card answer or its own reading: a proposal, never in force until the principal confirms it.
 * Idempotent in the store: the same words and decision as a live ruling give that ruling back (flagged `duplicate`), never
 * a new id, whoever asks (ruling.ts or the page), because the check and the insert are one transaction. A repeat of a held
 * proposal adds what it names to it (it all waits for the confirm); a repeat of a ruling already in force changes nothing at all
 * (`alreadyInForce`): a proposal is never the principal's word, so it can neither retire a ruling nor change one in force.
 */
export function propose(store: Store, words: string, decides: string, item?: string, opts?: RulingOpts, clock: Clock = Date.now): Recorded {
	const nowMs = clock();
	const o = checkOpts(opts, nowMs);
	return updateRulings(store, (list) => {
		checkSupersedes(list, o);
		const held = findHeld(list, words, decides, nowMs);
		if (held?.status === "in-force") {
			const notAdded = newSupersedes(held, o);
			return { ...held, duplicate: true as const, alreadyInForce: true as const, ...(notAdded.length ? { supersedesNotAdded: notAdded } : {}) };
		}
		if (held) { checkNoCycle(list, held, newSupersedes(held, o)); adopt(held, o, nowMs); return repeated(held, mergeSupersedes(list, held, o, nowMs)); }
		const r: Ruling = { id: nextId(list), date: today(nowMs), words, decides, source: "card", status: "proposed", confirmed: false, ...(item ? { item } : {}), ...o, history: [{ t: iso(nowMs), what: "proposed by the Steward" }] };
		list.push(r);
		return r;
	});
}

/** Pure: an in-force ruling, confirmed now, under the next free id of `list`. It is not saved and nothing is checked against `list`. */
export function inForceRuling(list: Ruling[], words: string, decides: string, source: RulingSource, how: string, item?: string, opts?: RulingOpts, nowMs: number = Date.now()): Ruling {
	const t = iso(nowMs);
	return { id: nextId(list), date: today(nowMs), words, decides, source, status: "in-force", confirmed: true, confirmedAt: t, ...(item ? { item } : {}), ...checkOpts(opts, nowMs), history: [{ t, what: how }] };
}

/**
 * In place on `list`: the ruling these words and this decision are, in force. A live ruling already holding them is that
 * ruling (a held proposal or unconfirmed card answer is put in force and confirmed, a missing expiry is added, anything the
 * restatement supersedes leaves force); otherwise a new one is added. Throws, changing nothing, on a bad option. It saves
 * nothing: the caller saves the list inside its own transaction (updateRulings, or stageRulings and commit).
 */
export function recordInForce(list: Ruling[], words: string, decides: string, source: RulingSource, how: string, item?: string, opts?: RulingOpts, nowMs: number = Date.now()): Recorded {
	const o = checkOpts(opts, nowMs);
	checkSupersedes(list, o);
	const held = findHeld(list, words, decides, nowMs);
	if (held) {
		checkNoCycle(list, held, newSupersedes(held, o));
		promote(list, held, `${how} (was not yet confirmed)`, nowMs);
		adopt(held, o, nowMs);
		return repeated(held, mergeSupersedes(list, held, o, nowMs));
	}
	const r = inForceRuling(list, words, decides, source, how, item, o, nowMs);
	list.push(r);
	applySupersedes(list, r, nowMs);
	return r;
}

/**
 * A rule the principal stated in their own words in chat, or one they confirmed on the page: in force at once. Idempotent, as
 * `propose` is: the same words and decision as a live ruling give that ruling back (flagged `duplicate`), and a held proposal
 * is put in force instead of being recorded a second time. `opts.supersedes` takes the rulings it replaces out of force in
 * the same write.
 */
export function addInForce(store: Store, words: string, decides: string, source: RulingSource, how: string, item?: string, opts?: RulingOpts, clock: Clock = Date.now): Recorded {
	const nowMs = clock();
	return updateRulings(store, (list) => recordInForce(list, words, decides, source, how, item, opts, nowMs));
}

function change(store: Store, id: string, fn: (r: Ruling) => void, after?: (list: Ruling[], r: Ruling) => void): Ruling {
	return updateRulings(store, (list) => {
		const r = list.find((x) => x.id === id);
		if (!r) throw Error(`no ruling ${id}`);
		fn(r);
		after?.(list, r);
		return r;
	});
}

/** Confirm from the rulings page: in force, confirmed, optionally with new wording for what it decides. An expired ruling can't be confirmed. */
export const confirmRuling = (store: Store, id: string, decides?: string, clock: Clock = Date.now) => change(store, id, (r) => {
	const nowMs = clock();
	if (r.status === "retired") throw Error(`${id} is retired`);
	if (isExpired(r, nowMs)) throw Error(`${id} expired on ${r.expires}`);
	const t = iso(nowMs);
	if (decides && decides.trim() && decides.trim() !== r.decides) { (r.history ??= []).push({ t, what: "wording edited on the page", from: r.decides }); r.decides = decides.trim(); }
	(r.history ??= []).push({ t, what: r.status === "proposed" ? "confirmed on the page (was a proposal)" : "confirmed on the page" });
	r.status = "in-force"; r.confirmed = true; r.confirmedAt = t;
}, (list, r) => {
	const c = supersedeCycle(list);
	if (c) throw Error(`confirming ${id} would put a supersede cycle in force: ${c.join(" → ")}`);
	applySupersedes(list, r, clock());
});

/** New wording only. It changes nothing about whether the ruling is in force or confirmed. */
export const editRuling = (store: Store, id: string, decides: string, clock: Clock = Date.now) => change(store, id, (r) => {
	if (!decides.trim()) throw Error("empty wording");
	(r.history ??= []).push({ t: iso(clock()), what: "wording edited on the page", from: r.decides });
	r.decides = decides.trim();
});

/**
 * Takes a ruling out of force. The page uses "retired" and "only this once". The housekeeping reasons ("superseded",
 * "duplicate", "expired", "repeat") need `why`; a duplicate also names the ruling `by` it duplicates, and `by` must be
 * another ruling that is still live. The record is never deleted.
 */
export const retireRuling = (store: Store, id: string, how: RetiredHow, why?: string, by?: string, clock: Clock = Date.now) => change(store, id, (r) => {
	if (r.status === "retired") return;
	if (how !== "retired" && how !== "only this once" && !why?.trim()) throw Error(`retiring ${id} as ${how} needs a reason`);
	if (how === "duplicate" && !by) throw Error(`retiring ${id} as ${how} needs the ruling that replaces it`);
	const t = iso(clock());
	(r.history ??= []).push({ t, what: how === "only this once" ? "only this once: settled its case, stands for nothing more" : how === "retired" ? "retired on the page" : `${how}${by ? ` (${by})` : ""}: ${why!.trim()}` });
	r.status = "retired"; r.retiredAt = t; r.retiredHow = how;
	if (why?.trim()) r.retiredWhy = why.trim();
	if (by) r.supersededBy = by;
}, (list, r) => {
	if (r.supersededBy && (r.supersededBy === r.id || !list.some((x) => x.id === r.supersededBy && x.status !== "retired"))) throw Error(`retiring ${r.id}: ${r.supersededBy} is not another ruling that is still live`);
});

// ---- reading ------------------------------------------------------------------------------------

/** Pure: the rulings in force at `nowMs`: status in-force and not past its `expires`. */
export const inForceNow = (list: Ruling[], nowMs: number = Date.now()) => list.filter((r) => r.status === "in-force" && !isExpired(r, nowMs));

/** Pure: the rulings that are still marked in force but whose `expires` has passed. They count for nothing and are left to be retired. */
export const expiredNow = (list: Ruling[], nowMs: number = Date.now()) => list.filter((r) => r.status === "in-force" && isExpired(r, nowMs));

/** Pure: the in-force rulings as the hand-off and every wake carry them, each with its ID. An expired one is left out. */
export function renderInForce(list: Ruling[], nowMs: number = Date.now()): string {
	return inForceNow(list, nowMs).map((r) => `- ${r.id} (${r.date}): "${r.words}" -> ${r.decides}${r.expires ? ` [expires ${r.expires}]` : ""}${r.until ? ` [until ${r.until}]` : ""}${r.confirmed ? "" : " [unconfirmed: began as a card answer]"}`).join("\n");
}

/** Pure: one line naming the rulings past their expiry, so a reader of the hand-off does not act on one from memory. Empty when none. */
export function renderExpired(list: Ruling[], nowMs: number = Date.now()): string {
	const e = expiredNow(list, nowMs);
	return e.length ? `Expired, NOT in force (do not act on them): ${e.map((r) => `${r.id} (expired ${r.expires})`).join(", ")}.` : "";
}

/** The rulings text for wakes: the in-force rulings with their IDs. Empty when none is in force. */
export const rulingsText = (store: Store, clock: Clock = Date.now): string => renderInForce(readRulings(store), clock());

/** The rulings section of the hand-off: the in-force rulings, then the expired ones by id. */
export const rulingsBriefText = (store: Store, clock: Clock = Date.now): string => {
	const list = readRulings(store);
	return [renderInForce(list, clock()), renderExpired(list, clock())].filter(Boolean).join("\n");
};

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

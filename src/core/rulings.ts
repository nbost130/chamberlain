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

import { checkOpts, iso, today } from "./rulings-expiry.ts";
import {
	adopt,
	applySupersedes,
	checkNoCycle,
	checkSupersedes,
	findHeld,
	mergeSupersedes,
	newSupersedes,
	promote,
	repeated,
} from "./rulings-supersede.ts";
import type { Store } from "./store.ts";

type RulingStatus = "in-force" | "proposed" | "retired";
type RulingSource = "chat" | "card";
export type RetiredHow = "retired" | "only this once" | "superseded" | "duplicate" | "expired" | "repeat";
/** The housekeeping reasons a ruling can leave force for. The database keeps them apart from the page's two (retired_reason, migration 11). */
export const HOUSEKEEPING: ReadonlySet<RetiredHow> = new Set<RetiredHow>([
	"superseded",
	"duplicate",
	"expired",
	"repeat",
]);
/** What a new ruling may carry beyond its words and what it decides. */
/** A ruling as it is put in force: what it says and decides, where it came from, how it was stated, and what it is about. */
type RulingInput = {
	words: string;
	decides: string;
	source: RulingSource;
	how: string;
	item?: string;
	opts?: RulingOpts;
};
export type RulingOpts = { expires?: string; until?: string; supersedes?: string[] };
/**
 * What recording returns: the ruling, flagged `duplicate` when it was already held (no new ruling was written), and on a repeat
 * the ids it named in `supersedes` that the held ruling did not yet replace (`supersedesAdded`): they were added to it.
 * A proposal that repeats a ruling already in force changes nothing (`alreadyInForce`): the ids it named that the ruling does not
 * replace are reported in `supersedesNotAdded`, because only the principal's word changes what is in force.
 */
export type Recorded = Ruling & {
	duplicate?: true;
	supersedesAdded?: string[];
	alreadyInForce?: true;
	supersedesNotAdded?: string[];
};
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
	return {
		list,
		commit: () => {
			for (const r of list) if (before.get(r.id) !== JSON.stringify(r)) store.rulings.save(r);
		},
	};
}

export const nextId = (list: Ruling[]) => `R${list.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1}`;
// ---- changes ------------------------------------------------------------------------------------

/**
 * The Steward's ruling from a card answer or its own reading: a proposal, never in force until the principal confirms it.
 * Idempotent in the store: the same words and decision as a live ruling give that ruling back (flagged `duplicate`), never
 * a new id, whoever asks (ruling.ts or the page), because the check and the insert are one transaction. A repeat of a held
 * proposal adds what it names to it (it all waits for the confirm); a repeat of a ruling already in force changes nothing at all
 * (`alreadyInForce`): a proposal is never the principal's word, so it can neither retire a ruling nor change one in force.
 */
export function propose(
	store: Store,
	{ words, decides, item, opts }: Pick<RulingInput, "words" | "decides" | "item" | "opts">,
	clock: Clock = Date.now,
): Recorded {
	const nowMs = clock();
	const o = checkOpts(opts, nowMs);
	return updateRulings(store, (list) => {
		checkSupersedes(list, o);
		const held = findHeld(list, words, decides, nowMs);
		if (held?.status === "in-force") {
			const notAdded = newSupersedes(held, o);
			return {
				...held,
				duplicate: true as const,
				alreadyInForce: true as const,
				...(notAdded.length ? { supersedesNotAdded: notAdded } : {}),
			};
		}
		if (held) {
			checkNoCycle(list, held, newSupersedes(held, o));
			adopt(held, o, nowMs);
			return repeated(held, mergeSupersedes(list, held, o, nowMs));
		}
		const r: Ruling = {
			id: nextId(list),
			date: today(nowMs),
			words,
			decides,
			source: "card",
			status: "proposed",
			confirmed: false,
			...(item ? { item } : {}),
			...o,
			history: [{ t: iso(nowMs), what: "proposed by the Steward" }],
		};
		list.push(r);
		return r;
	});
}

/** Pure: an in-force ruling, confirmed now, under the next free id of `list`. It is not saved and nothing is checked against `list`. */
export function inForceRuling(
	list: Ruling[],
	{ words, decides, source, how, item, opts }: RulingInput,
	nowMs: number = Date.now(),
): Ruling {
	const t = iso(nowMs);
	return {
		id: nextId(list),
		date: today(nowMs),
		words,
		decides,
		source,
		status: "in-force",
		confirmed: true,
		confirmedAt: t,
		...(item ? { item } : {}),
		...checkOpts(opts, nowMs),
		history: [{ t, what: how }],
	};
}

/**
 * In place on `list`: the ruling these words and this decision are, in force. A live ruling already holding them is that
 * ruling (a held proposal or unconfirmed card answer is put in force and confirmed, a missing expiry is added, anything the
 * restatement supersedes leaves force); otherwise a new one is added. Throws, changing nothing, on a bad option. It saves
 * nothing: the caller saves the list inside its own transaction (updateRulings, or stageRulings and commit).
 */
export function recordInForce(
	list: Ruling[],
	{ words, decides, source, how, item, opts }: RulingInput,
	nowMs: number = Date.now(),
): Recorded {
	const o = checkOpts(opts, nowMs);
	checkSupersedes(list, o);
	const held = findHeld(list, words, decides, nowMs);
	if (held) {
		checkNoCycle(list, held, newSupersedes(held, o));
		promote(list, held, `${how} (was not yet confirmed)`, nowMs);
		adopt(held, o, nowMs);
		return repeated(held, mergeSupersedes(list, held, o, nowMs));
	}
	const r = inForceRuling(list, { words, decides, source, how, item, opts: o }, nowMs);
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
export function addInForce(
	store: Store,
	{ words, decides, source, how, item, opts }: RulingInput,
	clock: Clock = Date.now,
): Recorded {
	const nowMs = clock();
	return updateRulings(store, (list) => recordInForce(list, { words, decides, source, how, item, opts }, nowMs));
}

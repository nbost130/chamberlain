/** Changes to a ruling already filed: confirm it, edit what it decides, retire it. */

import { type Clock, type RetiredHow, type Ruling, updateRulings } from "./rulings.ts";
import { isExpired, iso } from "./rulings-expiry.ts";
import { applySupersedes, logChange, supersedeCycle } from "./rulings-supersede.ts";
import type { Store } from "./store.ts";

function change(
	store: Store,
	id: string,
	fn: (r: Ruling) => void,
	after?: (list: Ruling[], r: Ruling) => void,
): Ruling {
	return updateRulings(store, (list) => {
		const r = list.find((x) => x.id === id);
		if (!r) throw Error(`no ruling ${id}`);
		fn(r);
		after?.(list, r);
		return r;
	});
}

/** Confirm from the rulings page: in force, confirmed, optionally with new wording for what it decides. An expired ruling can't be confirmed. */
export const confirmRuling = (store: Store, id: string, decides?: string, clock: Clock = Date.now) =>
	change(
		store,
		id,
		(r) => {
			const nowMs = clock();
			if (r.status === "retired") throw Error(`${id} is retired`);
			if (isExpired(r, nowMs)) throw Error(`${id} expired on ${r.expires}`);
			const t = iso(nowMs);
			if (decides?.trim() && decides.trim() !== r.decides) {
				logChange(r, { t, what: "wording edited on the page", from: r.decides });
				r.decides = decides.trim();
			}
			logChange(r, {
				t,
				what: r.status === "proposed" ? "confirmed on the page (was a proposal)" : "confirmed on the page",
			});
			r.status = "in-force";
			r.confirmed = true;
			r.confirmedAt = t;
		},
		(list, r) => {
			const c = supersedeCycle(list);
			if (c) throw Error(`confirming ${id} would put a supersede cycle in force: ${c.join(" → ")}`);
			applySupersedes(list, r, clock());
		},
	);

/** New wording only. It changes nothing about whether the ruling is in force or confirmed. */
export const editRuling = (store: Store, id: string, decides: string, clock: Clock = Date.now) =>
	change(store, id, (r) => {
		if (!decides.trim()) throw Error("empty wording");
		logChange(r, { t: iso(clock()), what: "wording edited on the page", from: r.decides });
		r.decides = decides.trim();
	});

/** Refuses a retirement that lacks what its reason needs. Returns the trimmed reason, if one was given. */
function checkRetirement(id: string, how: RetiredHow, why: string | undefined, by: string | undefined) {
	const reason = why?.trim();
	if (how !== "retired" && how !== "only this once" && !reason) throw Error(`retiring ${id} as ${how} needs a reason`);
	if (how === "duplicate" && !by) throw Error(`retiring ${id} as ${how} needs the ruling that replaces it`);
	return reason;
}

/** The history line for a retirement. A housekeeping reason always has `reason` by now: checkRetirement refused it otherwise. */
function retirementNote(how: RetiredHow, by: string | undefined, reason: string | undefined) {
	if (how === "only this once") return "only this once: settled its case, stands for nothing more";
	if (how === "retired") return "retired on the page";
	return `${how}${by ? ` (${by})` : ""}: ${reason ?? ""}`;
}

/**
 * Takes a ruling out of force. The page uses "retired" and "only this once". The housekeeping reasons ("superseded",
 * "duplicate", "expired", "repeat") need `why`; a duplicate also names the ruling `by` it duplicates, and `by` must be
 * another ruling that is still live. The record is never deleted.
 */
export const retireRuling = (
	store: Store,
	id: string,
	{ how, why, by }: { how: RetiredHow; why?: string; by?: string },
	clock: Clock = Date.now,
) =>
	change(
		store,
		id,
		(r) => {
			if (r.status === "retired") return;
			const reason = checkRetirement(id, how, why, by);
			const t = iso(clock());
			logChange(r, { t, what: retirementNote(how, by, reason) });
			r.status = "retired";
			r.retiredAt = t;
			r.retiredHow = how;
			if (reason) r.retiredWhy = reason;
			if (by) r.supersededBy = by;
		},
		(list, r) => {
			if (
				r.supersededBy &&
				(r.supersededBy === r.id || !list.some((x) => x.id === r.supersededBy && x.status !== "retired"))
			)
				throw Error(`retiring ${r.id}: ${r.supersededBy} is not another ruling that is still live`);
		},
	);

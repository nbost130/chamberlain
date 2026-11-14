/** Rulings, the decisions log, butlers and away records. */
import type { Butler } from "./butler.ts";
import { HOUSEKEEPING, type RetiredHow, type Ruling } from "./rulings.ts";
import { type Db, json, parse, type Row } from "./sqlite-db.ts";
import type { AwayRecord, DecisionRow, Store } from "./store.ts";

// ---- rulings, decisions, butlers, away ----------------------------------------------------------
/** The fields of a ruling's retirement: when and how it was confirmed, retired and superseded. */
const retirementFields = (r: Row): Partial<Ruling> => ({
	...(r.confirmed_at ? { confirmedAt: r.confirmed_at as string } : {}),
	...(r.retired_at ? { retiredAt: r.retired_at as string } : {}),
	...(r.retired_reason || r.retired_how ? { retiredHow: (r.retired_reason ?? r.retired_how) as RetiredHow } : {}),
	...(r.retired_why ? { retiredWhy: r.retired_why as string } : {}),
	...(r.superseded_by ? { supersededBy: r.superseded_by as string } : {}),
});
/** The fields of a ruling's reach: what it supersedes, when it expires, and what it waits on. */
const reachFields = (r: Row): Partial<Ruling> => ({
	...(r.supersedes ? { supersedes: parse<string[]>(r.supersedes) } : {}),
	...(r.expires ? { expires: r.expires as string } : {}),
	...(r.until_event ? { until: r.until_event as string } : {}),
	...(r.item ? { item: r.item as string } : {}),
});
const toRuling = (r: Row): Ruling => ({
	id: r.id as string,
	date: r.date as string,
	words: r.words as string,
	decides: r.decides as string,
	source: r.source as Ruling["source"],
	status: r.status as Ruling["status"],
	confirmed: r.confirmed === 1,
	...retirementFields(r),
	...reachFields(r),
	history: parse<Ruling["history"]>(r.history) ?? [],
});

const SAVE_RULING = `INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, confirmed_at, retired_at, retired_how, retired_reason, retired_why, superseded_by, supersedes, expires, until_event, item, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET date = excluded.date, words = excluded.words, decides = excluded.decides, source = excluded.source, status = excluded.status, confirmed = excluded.confirmed,
				 confirmed_at = excluded.confirmed_at, retired_at = excluded.retired_at, retired_how = excluded.retired_how, retired_reason = excluded.retired_reason, retired_why = excluded.retired_why, superseded_by = excluded.superseded_by,
				 supersedes = excluded.supersedes, expires = excluded.expires, until_event = excluded.until_event, item = excluded.item, history = excluded.history`;

/** The columns of a saved ruling, in the order of SAVE_RULING's placeholders. */
function rulingParams(r: Ruling): unknown[] {
	// A housekeeping reason is stored as retired_how 'retired' plus retired_reason (migration 11); the page's two are retired_how alone.
	const reason = r.retiredHow && HOUSEKEEPING.has(r.retiredHow) ? r.retiredHow : null;
	return [
		r.id,
		Number(r.id.slice(1)),
		r.date,
		r.words,
		r.decides,
		r.source,
		r.status,
		r.confirmed ? 1 : 0,
		r.confirmedAt ?? null,
		r.retiredAt ?? null,
		reason ? "retired" : (r.retiredHow ?? null),
		reason,
		r.retiredWhy ?? null,
		r.supersededBy ?? null,
		r.supersedes?.length ? JSON.stringify(r.supersedes) : null,
		r.expires ?? null,
		r.until ?? null,
		r.item ?? null,
		JSON.stringify(r.history ?? []),
	];
}

export const makeRulings = (c: Db): Store["rulings"] => ({
	list: () => c.all("SELECT * FROM rulings ORDER BY seq").map(toRuling),
	save(r) {
		c.run(SAVE_RULING, ...rulingParams(r));
	},
});

const toDecision = (r: Row): DecisionRow => ({
	t: r.t as string,
	thread: r.thread as string,
	decision: r.decision as string,
	ruling: r.ruling as string,
	...(r.ruling_ids ? { rulingIds: parse<string[]>(r.ruling_ids) } : {}),
	ref: (r.ref as string | null) ?? null,
});
export const makeDecisions = (c: Db): Store["decisions"] => ({
	append: (d) => {
		c.run(
			"INSERT INTO decisions (t, thread, decision, ruling, ruling_ids, ref) VALUES (?, ?, ?, ?, ?, ?)",
			d.t,
			d.thread,
			d.decision,
			d.ruling,
			json(d.rulingIds),
			d.ref,
		);
	},
	list: () => c.all("SELECT * FROM decisions ORDER BY id").map(toDecision),
});

const toButler = (r: Row): Butler => ({
	id: r.id as string,
	thread: r.thread as string,
	machine: r.machine as string,
	model: r.model as string,
	scope: r.scope as string,
	started: r.started as string,
	...(r.stopped ? { stopped: r.stopped as string } : {}),
	...(r.reason ? { reason: r.reason as string } : {}),
});
export const makeButlers = (c: Db): Store["butlers"] => ({
	list: () => c.all("SELECT * FROM butlers ORDER BY rowid").map(toButler),
	get: (id) => {
		const r = c.one("SELECT * FROM butlers WHERE id = ?", id);
		return r ? toButler(r) : undefined;
	},
	insert: (b) =>
		c.run(
			"INSERT INTO butlers (id, thread, machine, model, scope, started) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
			b.id,
			b.thread,
			b.machine,
			b.model,
			b.scope,
			b.started,
		).changes === 1,
	stop: (id, stopped, reason) =>
		c.run("UPDATE butlers SET stopped = ?, reason = ? WHERE id = ? AND stopped IS NULL", stopped, reason ?? null, id)
			.changes === 1,
});

const toAway = (r: Row): AwayRecord => ({
	enteredAt: r.entered_at as string,
	words: r.words as string,
	...(r.expected_return ? { expectedReturn: r.expected_return as string } : {}),
	...(r.spend_note ? { spendNote: r.spend_note as string } : {}),
});
export const makeAway = (c: Db): Store["away"] => ({
	current: () => {
		const r = c.one("SELECT * FROM away WHERE exited_at IS NULL");
		return r ? toAway(r) : undefined;
	},
	enter(a) {
		c.tx(() => {
			c.run("UPDATE away SET exited_at = ? WHERE exited_at IS NULL", a.enteredAt);
			c.run(
				"INSERT INTO away (entered_at, words, expected_return, spend_note) VALUES (?, ?, ?, ?)",
				a.enteredAt,
				a.words,
				a.expectedReturn ?? null,
				a.spendNote ?? null,
			);
		});
	},
	exit(at) {
		return c.tx(() => {
			const r = c.one("SELECT * FROM away WHERE exited_at IS NULL");
			if (!r) return undefined;
			c.run("UPDATE away SET exited_at = ? WHERE id = ?", at, r.id);
			return toAway(r);
		});
	},
});

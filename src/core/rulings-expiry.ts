/** A ruling's expiry: the dates it may name, whether it has passed, and the checks on a ruling's options. */
import type { Ruling, RulingOpts } from "./rulings.ts";

export const iso = (nowMs: number) => new Date(nowMs).toISOString();
export const today = (nowMs: number) => iso(nowMs).slice(0, 10);

// ---- expiry, duplicates, supersession -------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A date-time must say its zone: without one it would mean different moments on different machines.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Pure: the UTC moment these calendar fields name, or NaN when they name none. JavaScript's Date rolls an impossible field into
 * the next one (February 30 becomes March 2, hour 24 the next day), so the moment is built and its fields read back: any that
 * differ from the input mean the input does not exist.
 */
function realUtc({
	y,
	mo,
	d,
	h = 0,
	mi = 0,
	s = 0,
}: {
	y: number;
	mo: number;
	d: number;
	h?: number;
	mi?: number;
	s?: number;
}): number {
	const t = new Date(0);
	t.setUTCFullYear(y, mo - 1, d);
	t.setUTCHours(h, mi, s, 0);
	const same =
		t.getUTCFullYear() === y &&
		t.getUTCMonth() === mo - 1 &&
		t.getUTCDate() === d &&
		t.getUTCHours() === h &&
		t.getUTCMinutes() === mi &&
		t.getUTCSeconds() === s;
	return same ? t.getTime() : NaN;
}

/** Pure: is `expires` the shape of an ISO date or a date-time with a zone, whatever its numbers? */
const expiresShape = (expires: string) => DATE.test(expires) || DATE_TIME.test(expires);

/**
 * The moment an `expires` value ends, in ms. A date alone runs through the end of that day (UTC). NaN if it isn't one: a value
 * of the wrong shape, or one whose date or time does not exist (2027-02-30, 2027-02-29, month 13, hour 24, an offset past 23:59).
 */
export function expiresAt(expires: string): number {
	const day = DATE.exec(expires);
	if (day) {
		const start = realUtc({ y: Number(day[1]), mo: Number(day[2]), d: Number(day[3]) });
		return Number.isNaN(start) ? NaN : start + 86_400_000 - 1;
	}
	const m = DATE_TIME.exec(expires);
	if (!m) return NaN;
	const at = realUtc({
		y: Number(m[1]),
		mo: Number(m[2]),
		d: Number(m[3]),
		h: Number(m[4]),
		mi: Number(m[5]),
		s: Number(m[6] ?? 0),
	});
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
export const isExpired = (r: Pick<Ruling, "expires">, nowMs: number = Date.now()) => {
	const { expires } = r;
	return Boolean(expires && !(expiresAt(expires) > nowMs));
};

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

/**
 * `mail.schedule`: when a triage run starts (docs/EMAIL-TRIAGE.md, section 7). Weekdays at 07:30 and 16:30 by default, as the operator
 * answered design question 1, plus whenever the Steward runs it. `times` may be empty: then only the Steward starts a run. The timer that
 * acts on this is B8 (#41); this file only says what the setting is, and checks it.
 */
import { num, object, str } from "../../core/config-fields.ts";

export type Schedule = {
	/** "HH:MM", 24 hour, in `tz`. */
	times: string[];
	/** "daily", or days and ranges: "mon-fri", "mon,wed,fri". */
	days: string;
	/** An IANA time zone name, or "local" for the machine's own. */
	tz: string;
	maxRunsPerDay: number;
};

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Pure: the days "mon-fri" or "mon,wed,fri" names, as 0 (Monday) to 6, or undefined when it is not a days string. "daily" is all seven. */
export function daysOf(text: string): number[] | undefined {
	if (text === "daily") return [0, 1, 2, 3, 4, 5, 6];
	const out = new Set<number>();
	for (const part of text.split(",")) {
		const [from, to = from, extra] = part.split("-");
		const a = DAYS.indexOf(from ?? ""),
			b = DAYS.indexOf(to);
		if (a < 0 || b < 0 || extra !== undefined || b < a) return undefined;
		for (let i = a; i <= b; i++) out.add(i);
	}
	return [...out].sort();
}

const knownZone = (tz: string): boolean => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

function parseTimes(v: unknown, where: string, d: string[]): string[] {
	if (v === undefined) return [...d];
	if (!Array.isArray(v) || v.length > 24 || !v.every((t) => typeof t === "string" && TIME.test(t)))
		throw Error(`${where}: times must be a list of at most 24 "HH:MM" times (24 hour)`);
	if (new Set(v).size !== v.length) throw Error(`${where}: each time must be different`);
	return [...(v as string[])].sort();
}

/** Pure: the schedule, with defaults for what is left out. */
export function parseSchedule(raw: unknown, where: string, d: Schedule): Schedule {
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, where, ["times", "days", "tz", "maxRunsPerDay"]);
	const days = str(o, "days", where, d.days);
	if (!daysOf(days))
		throw Error(`${where}: days must be "daily", or days and ranges such as "mon-fri" or "mon,wed,fri"`);
	const tz = str(o, "tz", where, d.tz);
	if (tz !== "local" && !knownZone(tz)) throw Error(`${where}: tz must be "local" or an IANA time zone name`);
	return {
		times: parseTimes(o.times, where, d.times),
		days,
		tz,
		maxRunsPerDay: num(o, "maxRunsPerDay", where, { d: d.maxRunsPerDay, whole: true }),
	};
}

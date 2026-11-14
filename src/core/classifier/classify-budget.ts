/** The classifier's daily budget: how many calls and dollars it has spent today and what is left. */

import type { Run } from "./classify.ts";
import { DAY_MS, short } from "./classify-shared.ts";
import { SENDS_TEXT } from "./config.ts";

/** The state-table key of the day's attempt count: every call to a provider that sends text, and what they cost. */
export const USAGE_KEY = "classifier-usage";
type DailyUsage = { day: string; calls: number; usd: number };

/** Pure: the start of `now`'s UTC day, in ms. The daily budget resets there. */
export const utcDayStart = (now: number) => now - (now % DAY_MS);

/**
 * The day's usage so far, for a provider that sends text. Every attempt is counted in the state table as it is made (a retry of a failed
 * call counts again, though it replaces its one disposition row), and the count is never taken as less than the dispositions' own sum for the day.
 */
export function readDailyUsage(run: Run): { calls: number; usd: number } {
	try {
		if (!run.sends) return { calls: 0, usd: 0 };
		const rows = run.d.store.dispositions.usage(utcDayStart(run.d.now), SENDS_TEXT);
		const counted = run.d.store.state.get<DailyUsage>(USAGE_KEY);
		const today = counted?.day === run.day ? counted : { calls: 0, usd: 0 };
		return { calls: Math.max(rows.calls, today.calls), usd: Math.max(rows.usd, today.usd) };
	} catch (e) {
		run.d.log("classifier-error", { error: `the day's usage could not be read: ${short(e)}` });
		return { calls: Number.POSITIVE_INFINITY, usd: 0 };
	}
}

/** Adds calls and spend to the day's count in the state table. Only a provider that sends text is counted; a failure is logged, not thrown. */
export function countUsage(run: Run, calls: number, usd: number) {
	if (!run.sends || (!calls && !usd)) return;
	try {
		run.d.store.state.update<DailyUsage>(USAGE_KEY, (prior) => {
			const p = prior?.day === run.day ? prior : { day: run.day, calls: 0, usd: 0 };
			return { day: run.day, calls: p.calls + calls, usd: p.usd + usd };
		});
	} catch (e) {
		run.d.log("classifier-error", { error: `the day's usage could not be counted: ${short(e)}` });
	}
}

/** Why no more calls may start, or undefined while the budget holds. */
export function budgetLeft(run: Run): string | undefined {
	const { budget } = run.c;
	if (run.started >= budget.maxPerRun) return "budget: maxPerRun reached this run; classified on a later run";
	if (run.sends && run.used.calls + run.started >= budget.maxCallsPerDay)
		return "budget: maxCallsPerDay spent until the next UTC day";
	if (run.sends && run.used.usd + run.spent >= budget.maxUsdPerDay)
		return "budget: maxUsdPerDay spent until the next UTC day";
	return undefined;
}

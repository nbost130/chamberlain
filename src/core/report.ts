/**
 * The wait before a report wake, and the last decision on it. A thread that ended its turn may only be waiting on its
 * own background work, so the wake belongs to the last turn end, once nothing is left running. A wake waits out its
 * quiet window, then any background work or child threads, for up to REPORT_HOLD_MS. Past that it goes anyway: a hung
 * task must not swallow a report.
 */

import { reportStillDue, type ThreadState } from "./decide.ts";
import { type InstructionRead, skipEvent } from "./history.ts";
import { setting } from "./layout.ts";

export const REPORT_HOLD_MS = 60 * 60_000;
/** The hold in force: `reportHoldMs` (CHAMBERLAIN_REPORT_HOLD_MS, else config.json), else the default above. */
const reportHoldMs = (): number => setting("reportHoldMs") ?? REPORT_HOLD_MS;
const POLL_MS = 30_000;

/** Pure: how long a report must still wait. Zero means now. */
export function reportWait(quietUntil: number, now: number, busy: boolean, holdMs = reportHoldMs()): number {
	if (now < quietUntil) return quietUntil - now;
	if (busy && now < quietUntil + holdMs) return Math.min(POLL_MS, quietUntil + holdMs - now);
	return 0;
}

export type ReportWatch = {
	now(): number;
	sleep(ms: number): Promise<void>;
	/** The end of the quiet window. Each finished turn pushes it back, so it stays set until this returns. */
	quietUntil(): number;
	state(): ThreadState | undefined;
	/** Child threads and subagents still running. */
	children(): Promise<number>;
	oldCards(): ReadonlySet<string>;
	read(): Promise<InstructionRead>;
	reportKey(read: InstructionRead): string | undefined;
	idleWork(t: ThreadState, read: InstructionRead): Promise<{ key: string; work: string } | undefined>;
};
export type ReportOutcome =
	| { wake: true; key: string; work: string; running: number; oldCard: boolean }
	| { wake: false; event: string };

/** How long the wait has left: the quiet window first, then the hold while the thread still has work running. */
async function waitLeft(w: ReportWatch): Promise<number> {
	if (w.now() < w.quietUntil()) return w.quietUntil() - w.now();
	const s = w.state();
	return reportWait(w.quietUntil(), w.now(), s !== undefined && (s.backgroundWork > 0 || (await w.children()) > 0));
}

/** The outcome once the wait is over: a wake when there is a key and the report is still due, a skip otherwise. Runs with no await in it. */
function outcomeAt(
	w: ReportWatch,
	read: InstructionRead,
	{ wakeKey, work, after }: { wakeKey: string | undefined; work: string | undefined; after: ThreadState | undefined },
): ReportOutcome {
	if (!wakeKey || !after || !reportStillDue(after, w.oldCards()))
		return { wake: false, event: skipEvent(read, "skip-report-superseded") };
	return {
		wake: true,
		key: wakeKey,
		work: work ?? "",
		running: after.backgroundWork,
		oldCard: after.pendingRequestId !== null,
	};
}

export async function settleReport(w: ReportWatch): Promise<ReportOutcome> {
	const left = () => waitLeft(w);
	let retried = false;
	for (;;) {
		for (let ms = await left(); ms > 0; ms = await left()) await w.sleep(ms);
		// Read the instruction again: the principal may have taken the thread over during the wait.
		const read = await w.read();
		if (read.state === "failed" && !retried) {
			retried = true;
			await w.sleep(POLL_MS);
			continue;
		}
		const key = w.reportKey(read);
		const seen = w.state();
		const idle = key || !seen ? undefined : await w.idleWork(seen, read);
		// The reads can outlast a new turn end or new work. Then the wait isn't over, and this read is old.
		if ((await left()) > 0) continue;
		// State last, with no await before the return: a new turn or card must count.
		const after = w.state();
		return outcomeAt(w, read, { wakeKey: key ?? idle?.key, work: idle?.work, after });
	}
}

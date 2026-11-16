/**
 * Switch-notice liveness (design §2.4 / G1–G2): the current generation's notice must gain a
 * counting receipt within SWITCH_NOTICE_STALL_MS or raise steward-switch-unacknowledged.
 * Pending and dead-letter notices past the deadline also raise (G2 / R3).
 */
import type { AlarmText } from "../messages.ts";
import type { Store } from "../store/store.ts";
import { isDischarged } from "./steward-discharge.ts";
import { SWITCH_NOTICE_STALL_MS } from "./steward-types.ts";

const switchUnacknowledgedAlarm = (noticeId: string, stallMinutes: number): AlarmText => ({
	title: "chamberlain: Steward switch notice unacknowledged",
	summary: `The current Steward has not completed a run that inputs switch notice ${noticeId} within ${stallMinutes} minutes. Rollback is the remedy; retired notices are not obligations.`,
});

/** Transfer whose to_gen is the current MAX(gen) — that generation's switch notice. */
function currentNoticeTransfer(store: Store) {
	const max = store.steward.maxGen();
	if (max < 2) return undefined;
	return store.steward.transfer(max - 1);
}

/**
 * Raise steward-switch-unacknowledged when the current notice is past stallMs without a counting receipt.
 * Deadline is the obligation's creation (queuedAt / openedAt), so pending and dead-letter notices also alarm (G2).
 * Retired (non-current) notices are ignored.
 */
export function checkSwitchNotice(
	store: Store,
	alarm: (key: string, title: string, summary: string) => void,
	now = Date.now(),
	stallMs = SWITCH_NOTICE_STALL_MS,
): boolean {
	const t = currentNoticeTransfer(store);
	if (!t) return false;
	const row = store.wakes.find(t.noticeId);
	if (!row) return false;
	if (row.status === "cancelled") return false;
	if (isDischarged(store, row.id)) return false;
	const start = row.createdAt;
	if (now - start < stallMs) return false;
	const a = switchUnacknowledgedAlarm(t.noticeId, Math.round(stallMs / 60_000));
	alarm("steward-switch-unacknowledged", a.title, a.summary);
	return true;
}

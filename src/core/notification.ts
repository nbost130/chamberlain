/**
 * The one function that decides whether an item sends a notification, and whether it sends another.
 *
 * Every re-notification in Chamberlain goes through `decideNotification`: a sweep finding that persists, a dead-man alarm that
 * stays true, a wake that must go out once, a question nobody has answered. (An item is what monitoring tools call an alert;
 * what it sends to the Steward is a notification, which Chamberlain calls a wake.) A source says what it wants as a
 * `RepeatPolicy` (how long to wait between notifications, and how many to send at most); this function says whether it is
 * time. Nothing else may keep a "seen", "already sent" or "last notified" record, and `src/architecture.test.ts` fails if
 * something does.
 *
 * The item's mode picks which counters it reads and advances:
 *   silenced  never notifies (Alertmanager: a silenced alert is still tracked).
 *   shadow    counts what it WOULD have sent, in the shadow columns, and notifies nobody.
 *   live      counts real notifications, in the live columns.
 * The two pairs are kept apart, so an item that has been in shadow mode for a month and is then switched live notifies for
 * the first time: a would-be notification is never mistaken for one that was sent.
 */
import type { ItemMode, ItemStatus, RepeatPolicy } from "./store.ts";

/**
 * The item source of the record of which wakes already went out: one item per dedup key, notified once, so none goes
 * again. (Alertmanager keeps the same record and calls it its notification log.)
 */
export const NOTIFICATION_LOG = "notification-log";

/** One notification, ever. */
export const NOTIFY_ONCE: RepeatPolicy = { intervalsMs: [], maxNotifications: 1 };

/** Notify again `everyMs` after each notification, for as long as the item persists, at most `max` times (default: without end). Alertmanager's `repeat_interval`. */
export const repeatEvery = (everyMs: number, max = Number.POSITIVE_INFINITY): RepeatPolicy => ({
	intervalsMs: [everyMs],
	maxNotifications: max,
});

/** Notify, then again after each of `intervalsMs` in turn (the last repeats), at most `max` times: a repeat interval that grows. */
export const repeatAtIntervals = (intervalsMs: readonly number[], max: number): RepeatPolicy => ({
	intervalsMs,
	maxNotifications: max,
});

/** The notification-relevant part of an item. */
export type NotificationState = {
	status: ItemStatus;
	mode: ItemMode;
	notificationCount: number;
	nextNotificationAt: number | null;
	shadowNotificationCount: number;
	shadowNextNotificationAt: number | null;
};

export type NotificationDecision = {
	/** A real notification goes out now (live mode). */
	notify: boolean;
	/** Shadow mode: one would have gone out now. */
	wouldNotify: boolean;
	/** The counters to store after this decision, for the mode's own pair. Unchanged when nothing is sent. */
	count: number;
	nextAt: number | null;
};

/**
 * Pure. Whether the item notifies at `now`: never while it is acknowledged or resolved or its mode is silenced; the first
 * time it is seen; then again once `nextNotificationAt` has passed, until the policy's maximum is reached.
 */
export function decideNotification(s: NotificationState, policy: RepeatPolicy, now: number): NotificationDecision {
	const live = s.mode === "live";
	const count = live ? s.notificationCount : s.shadowNotificationCount;
	const due = live ? s.nextNotificationAt : s.shadowNextNotificationAt;
	const idle: NotificationDecision = { notify: false, wouldNotify: false, count, nextAt: due };
	if (s.mode === "silenced" || s.status === "acknowledged" || s.status === "resolved" || policy.maxNotifications < 1)
		return idle;
	const fires = count === 0 || (due !== null && now >= due && count < policy.maxNotifications);
	if (!fires) return idle;
	const n = count + 1;
	const step =
		n < policy.maxNotifications && policy.intervalsMs.length
			? policy.intervalsMs[Math.min(n - 1, policy.intervalsMs.length - 1)]
			: undefined;
	return { notify: live, wouldNotify: !live, count: n, nextAt: step === undefined ? null : now + step };
}

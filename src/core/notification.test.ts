import { describe, expect, test } from "bun:test";
import { decideNotification, repeatAtIntervals, NOTIFY_ONCE, repeatEvery, type NotificationState } from "./notification.ts";

const fresh = (o: Partial<NotificationState> = {}): NotificationState => ({ status: "triggered", mode: "live", notificationCount: 0, nextNotificationAt: null, shadowNotificationCount: 0, shadowNextNotificationAt: null, ...o });
const HOUR = 3600_000;

describe("decideNotification: the one function that says whether an item alerts", () => {
	test("a new item alerts once, and a ladder with no steps never again", () => {
		const first = decideNotification(fresh(), NOTIFY_ONCE, 1000);
		expect(first).toEqual({ notify: true, wouldNotify: false, count: 1, nextAt: null });
		expect(decideNotification(fresh({ notificationCount: 1 }), NOTIFY_ONCE, 9e9).notify).toBe(false);
	});

	test("a repeating ladder waits its step, then alerts again, without end", () => {
		const l = repeatEvery(HOUR);
		const a = decideNotification(fresh(), l, 0);
		expect(a).toMatchObject({ notify: true, count: 1, nextAt: HOUR });
		expect(decideNotification(fresh({ status: "triggered", notificationCount: 1, nextNotificationAt: HOUR }), l, HOUR - 1).notify).toBe(false);
		const b = decideNotification(fresh({ status: "triggered", notificationCount: 1, nextNotificationAt: HOUR }), l, HOUR);
		expect(b).toMatchObject({ notify: true, count: 2, nextAt: 2 * HOUR });
		expect(decideNotification(fresh({ status: "triggered", notificationCount: 500, nextNotificationAt: 0 }), l, 1).notify).toBe(true);
	});

	test("an escalating ladder follows its steps, repeats the last, and stops at the cap", () => {
		const l = repeatAtIntervals([10, 100], 4);
		const times: number[] = [];
		let s = fresh(), now = 0;
		for (let i = 0; i < 10; i++) {
			const d = decideNotification(s, l, now);
			if (d.notify) { times.push(now); s = fresh({ status: "triggered", notificationCount: d.count, nextNotificationAt: d.nextAt }); }
			now += 1;
			if (d.nextAt !== null && i < 9) now = Math.max(now, d.nextAt);
		}
		expect(times).toEqual([0, 10, 110, 210]);
		expect(s.notificationCount).toBe(4);
		expect(s.nextNotificationAt).toBeNull();
	});

	test("acknowledged, resolved and off items never alert", () => {
		for (const o of [{ status: "acknowledged" as const }, { status: "resolved" as const }, { mode: "silenced" as const }]) expect(decideNotification(fresh(o), NOTIFY_ONCE, 0)).toMatchObject({ notify: false, wouldNotify: false });
	});

	test("a cap below one never alerts", () => {
		expect(decideNotification(fresh(), { intervalsMs: [], maxNotifications: 0 }, 0).notify).toBe(false);
	});

	test("log mode counts would-alerts in its own columns and alerts nobody", () => {
		const d = decideNotification(fresh({ mode: "shadow" }), repeatEvery(HOUR), 0);
		expect(d).toEqual({ notify: false, wouldNotify: true, count: 1, nextAt: HOUR });
		// The live counters are what live mode reads: a month of would-alerts leaves the first real alert still due.
		const live = decideNotification(fresh({ mode: "live", notificationCount: 0, shadowNotificationCount: 30, shadowNextNotificationAt: 99 }), repeatEvery(HOUR), 5);
		expect(live).toMatchObject({ notify: true, wouldNotify: false, count: 1 });
	});
});

import { alarms } from "../messages.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import type { PrepareFailure, PrepareReason } from "./preflight.ts";
import { type Ctx, type Lane, raise } from "./relay-ctx.ts";

const alarmKeys = (l: Lane) => [l.akey("wake-preflight"), l.akey("model-quota")];
const timerKey = (l: Lane) => l.akey("wake-preflight-since");
const DEFAULT_ALARM_AFTER_MS = 15 * 60_000;
type Interval = { reason: PrepareReason; since: number };

export function clearPreflightAlarm(r: Ctx, l: Lane): void {
	const open = alarmKeys(l).filter((key) => alarmOpen(r, key));
	const timer = timerKey(l);
	const timed = r.store.state.get(timer) !== undefined;
	if (open.length === 0 && !timed) return;
	r.store.tx(() => {
		if (timed) r.store.state.delete(timer);
		for (const key of open) r.store.items.resolve("alarm", key, r.clock());
	});
}

function alarmOpen(r: Ctx, key: string): boolean {
	const item = r.store.items.get("alarm", key);
	return !!item && item.status !== "resolved";
}

function sustained(r: Ctx, l: Lane, reason: PrepareReason, now: number): boolean {
	if (reason !== "busy" && reason !== "unreachable") return true;
	const key = timerKey(l);
	const stored = r.store.state.get<Interval>(key);
	const since = stored?.reason === reason && stored.since <= now ? stored.since : now;
	if (stored?.reason !== reason || stored.since !== since) r.store.state.set(key, { reason, since });
	return now - since >= (r.d.preflightAlarmAfterMs ?? DEFAULT_ALARM_AFTER_MS);
}

export function recordPreflightFailure(r: Ctx, l: Lane, row: OutboxRow, failure: PrepareFailure): void {
	const { reason, detail, retryAfterMs } = failure;
	const now = r.clock();
	r.notBefore.set(row.id, now + Math.max(r.pause(1), retryAfterMs ?? 0));
	if (r.preflightReasons.get(row.id) !== reason) {
		r.d.log("deliver-preflight-failed", {
			deliveryId: row.deliveryId,
			reason,
			detail,
			...(l.name ? { receiver: l.name } : {}),
		});
		r.preflightReasons.set(row.id, reason);
	}
	const [key, quota] = alarmKeys(l);
	if (alarmOpen(r, key) || alarmOpen(r, quota) || !sustained(r, l, reason, now)) return;
	raise(r, reason === "quota" ? quota : key, alarms.wakePreflight(l.name ?? "Steward", failure));
}

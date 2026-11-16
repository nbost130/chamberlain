/** Dispatch queued obligations and run the SLA ladder. */

import type { Outbox } from "../delivery/deliver.ts";
import type { Store } from "../store/store.ts";
import type { CrashPoint } from "./alert-desk-cursor.ts";
import { ALERT_TRIAGE, TRIAGE_WAKE_KIND, type TriageConfig } from "./alert-triage-config.ts";
import { asOb, attemptId, listObligations, markSent, redispatch, slotCount } from "./alert-triage-obligation.ts";
import { wakeText } from "./alert-triage-wake.ts";

const DAY_MS = 24 * 3600_000;
const BACKLOG_MS = 15 * 60_000;

export type DispatchCtx = {
	store: Store;
	outbox: Outbox;
	now: number;
	cfg: TriageConfig;
	crash: (p: CrashPoint) => void;
	alarm: (id: string, title: string, body: string) => void;
	clearAlarm: (id: string) => void;
};

function slaInterval(cfg: TriageConfig, missed: number): number {
	return Math.min(cfg.ackMinutes * 60_000 * 2 ** missed, 240 * 60_000);
}

type Due = { reason: string; dueAt: number };

function rowDue(
	row: { status: string; finishedAt?: number },
	now: number,
	wait: number,
	kind: string,
): Due | undefined {
	if (row.status === "pending" || row.status === "sending") return undefined;
	const dueAt = (row.finishedAt ?? 0) + wait;
	if (now >= dueAt) return { reason: kind, dueAt };
	return undefined;
}

function dueOf(store: Store, ob: ReturnType<typeof asOb>, now: number, cfg: TriageConfig): Due | undefined {
	if (ob.state === "acked")
		return !ob.repeated && Date.parse(ob.lastSeen) - (ob.ackedAt ?? 0) > DAY_MS
			? { reason: "repeat", dueAt: (ob.ackedAt ?? 0) + DAY_MS }
			: undefined;
	if (ob.state !== "sent") return undefined;
	const id = ob.attempts.at(-1);
	if (!id) return { reason: "missing", dueAt: now };
	const row = store.wakes.find(id);
	if (row?.status === "delivered") return rowDue(row, now, slaInterval(cfg, ob.missed), "sla");
	if (row?.status === "dead_letter") return rowDue(row, now, slaInterval(cfg, 0), "dead");
	if (row?.status === "cancelled") return rowDue(row, now, slaInterval(cfg, 0), "cancelled");
	if (row) return undefined;
	if (!store.wakes.known(id)) return { reason: "missing", dueAt: now };
	return { reason: "sla", dueAt: now }; // tombstone only → due now
}

export function runSla(c: DispatchCtx): void {
	for (const item of c.store.items.list({ source: ALERT_TRIAGE, kind: "obligation", status: "triggered" })) {
		const ob = asOb(item.payload);
		const due = dueOf(c.store, ob, c.now, c.cfg);
		if (!due) continue;
		if (due.reason === "sla") c.store.items.patch(ALERT_TRIAGE, item.dedupKey, { missed: ob.missed + 1 });
		// readyAt is the deadline, not pass time — preserves due order across redispatches (M4).
		redispatch({
			store: c.store,
			ok: item.dedupKey,
			reason: due.reason,
			readyAt: due.dueAt,
			slot: due.reason !== "repeat",
		});
	}
}

function keyForOcc(store: Store, occ: string): string | undefined {
	return store.items
		.list({ source: ALERT_TRIAGE, kind: "obligation", status: "triggered" })
		.find((i) => asOb(i.payload).occ === occ)?.dedupKey;
}

export function runDispatch(c: DispatchCtx): number {
	const queued = listObligations(c.store)
		.filter((o) => o.state === "queued")
		.sort((a, b) => a.readyAt - b.readyAt);
	let written = 0;
	for (const ob of queued) {
		if (written >= c.cfg.batchPerTick) break;
		if (!ob.slot && slotCount(c.store) >= c.cfg.maxInFlight) continue;
		const key = keyForOcc(c.store, ob.occ);
		if (!key) continue;
		const id = attemptId(ob.occ, ob.ordinal);
		const remain = Math.max(0, queued.length - written - 1);
		const kind = c.outbox.commit(() => {
			markSent(c.store, key, id, true);
			return {
				deliveryId: id,
				message: wakeText({
					occ: ob.occ,
					ordinal: ob.ordinal,
					rule: ob.rule,
					right: ob.right,
					event: ob.event,
					firstSeen: ob.firstSeen,
					folded: ob.folded,
					readyAt: ob.readyAt,
					now: c.now,
					waiting: remain,
				}),
				meta: { kind: TRIAGE_WAKE_KIND },
			};
		});
		if (kind === "queued" || kind === "known") {
			written++;
			c.crash("triage-dispatched");
		}
	}
	const oldest = listObligations(c.store)
		.filter((o) => o.state === "queued")
		.sort((a, b) => a.readyAt - b.readyAt)[0];
	if (oldest && c.now - oldest.readyAt > BACKLOG_MS)
		c.alarm("alert-triage-backlog", "alert triage backlog", "Queued alert tasks older than 15 minutes.");
	else c.clearAlarm("alert-triage-backlog");
	return written;
}

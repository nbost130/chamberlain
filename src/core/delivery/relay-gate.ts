/** The gate before an attempt: is the row still wanted, is the destination ready, and is it still the same Steward generation. */
import { alarms } from "../messages.ts";
import { type GenSnapshot, snapshotGen } from "../steward/steward-gens.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import { QuotaExhausted } from "./deliver.ts";
import { type Ctx, type Lane, raise } from "./relay-ctx.ts";

export async function prepared(
	r: Ctx,
	l: Lane,
	row: OutboxRow,
	destination: { threadId?: string; target?: string },
): Promise<boolean> {
	const state = await r.d.validateWake?.(row);
	if (state === "cancel") {
		r.store.wakes.cancel(row.deliveryId, r.clock());
		return false;
	}
	if (state === "wait") return false;
	if (!l.wake.prepare) return true;
	const quotaKey = l.akey("model-quota");
	const priorAlarm = r.store.items.get("alarm", quotaKey);
	const alarmOpen = priorAlarm && priorAlarm.status !== "resolved";
	try {
		if (await l.wake.prepare(destination.threadId, destination.target)) {
			if (alarmOpen) r.store.items.resolve("alarm", quotaKey);
			return true;
		}
	} catch (error) {
		if (error instanceof QuotaExhausted && !alarmOpen) {
			raise(r, quotaKey, alarms.modelQuota(l.name ?? "Steward"));
		}
	}
	r.notBefore.set(row.id, r.clock() + r.pause(1));
	// Said once per row: a preflight that keeps failing holds the row for good, and silence hid that for a whole receiver once.
	const key = `preflight:${row.id}`;
	if (!r.reported.has(key)) {
		r.reported.add(key);
		r.d.log("deliver-preflight-failed", { deliveryId: row.deliveryId, ...(l.name ? { receiver: l.name } : {}) });
	}
	return false;
}

export function readSnap(r: Ctx): GenSnapshot | undefined {
	return r.d.genSnapshot ? r.d.genSnapshot() : snapshotGen(r.store, r.d.conf);
}

export function sameGen(a: GenSnapshot | undefined, b: GenSnapshot | undefined): boolean {
	return a?.gen === b?.gen;
}

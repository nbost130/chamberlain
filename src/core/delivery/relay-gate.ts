/** The gate before an attempt: is the row still wanted, is the destination ready, and is it still the same Steward generation. */
import { type GenSnapshot, snapshotGen } from "../steward/steward-gens.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import { prepareSafely } from "./preflight.ts";
import type { Ctx, Lane } from "./relay-ctx.ts";
import { clearPreflightAlarm, recordPreflightFailure } from "./relay-preflight.ts";

export async function prepared(
	r: Ctx,
	l: Lane,
	row: OutboxRow,
	destination: { threadId?: string; target?: string },
): Promise<boolean> {
	const state = await r.d.validateWake?.(row);
	if (state === "cancel") {
		r.store.wakes.cancel(row.deliveryId, r.clock());
		r.preflightReasons.delete(row.id);
		return false;
	}
	if (state === "wait") return false;
	if (!l.wake.prepare) return true;
	const result = await prepareSafely(l.wake, destination.threadId, destination.target);
	if (!r.d.lock.held()) return false;
	if (result.ok) {
		r.preflightReasons.delete(row.id);
		clearPreflightAlarm(r, l);
		return true;
	}
	recordPreflightFailure(r, l, row, result);
	return false;
}

export function readSnap(r: Ctx): GenSnapshot | undefined {
	return r.d.genSnapshot ? r.d.genSnapshot() : snapshotGen(r.store, r.d.conf);
}

export function sameGen(a: GenSnapshot | undefined, b: GenSnapshot | undefined): boolean {
	return a?.gen === b?.gen;
}

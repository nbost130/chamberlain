/** The gate before an attempt: is the row still wanted, is the destination ready, and is it still the same Steward generation. */
import { type GenSnapshot, snapshotGen } from "../steward/steward-gens.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import type { Ctx, Lane } from "./relay-ctx.ts";

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
	try {
		if (await l.wake.prepare(destination.threadId, destination.target)) return true;
	} catch {
		/* A preflight has sent no message; retain the row. */
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

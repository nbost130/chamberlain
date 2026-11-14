/** The rights a wake needs ahead of it: finding the prerequisite wake, queueing it, and sending it first. */
import { crashPoint } from "./crash.ts";
import { readRightsNow } from "./relay-compose.ts";
import type { Ctx, RelayDeps, RightsNow } from "./relay-ctx.ts";
import { rightsFirstId, rightsFirstKey, rightsStateKey } from "./rights-sent.ts";
import type { Store } from "./store.ts";
import type { OutboxRow } from "./store-wakes.ts";

/** The ids `:1`, `:2`, ... of the prerequisite for a state, where each stands: delivered, cancelled, or not ended (or unknown). */
function prerequisiteStatus(store: Store, id: string): string | undefined {
	const row = store.wakes.find(id);
	if (row) return row.status;
	if (!store.wakes.known(id)) return undefined;
	return store.wakes.isDelivered(id) ? "delivered" : "cancelled";
}

/**
 * The prerequisite for this state: the first of `:1`, `:2`, ... that has not ended. One that ended delivered without the record showing
 * it now (a compaction cleared it), or that the operator cancelled, gives way to the next. Undefined (and logged) after fifty.
 */
export function findPrerequisite(r: Ctx, row: OutboxRow, key: string): { id: string; delivered: boolean } | undefined {
	let delivered = false;
	for (let n = 1; ; n++) {
		if (n > 50) {
			r.d.log("rights-first-error", {
				deliveryId: row.deliveryId,
				error: "50 prerequisites for one state have ended without the record showing it",
			});
			return undefined;
		}
		const id = rightsFirstId(row.deliveryId, key, n);
		const status = prerequisiteStatus(r.store, id);
		if (status === "delivered") {
			delivered = true;
			continue;
		}
		if (status !== "cancelled") return { id, delivered };
	}
}

/** Writes the prerequisite for a row, and only while the row still waits; the row itself is left exactly as it is. Undefined (and logged) when it cannot be queued. */
export function queuePrerequisite(
	r: Ctx,
	row: OutboxRow,
	now: RightsNow,
	{ id, reason }: { id: string; reason: string },
): OutboxRow | undefined {
	const { d, store } = r;
	const t = r.clock();
	let done: boolean;
	try {
		done = store.tx(() => {
			// The row is left exactly as it is; only the prerequisite is written, and only while the row still waits.
			if (store.wakes.find(row.deliveryId)?.status !== "pending") return false;
			const w = now.wake(row.deliveryId);
			if (
				!store.wakes.enqueue({
					deliveryId: id,
					message: w.message,
					queuedAt: t,
					kind: "rights",
					...(w.stamp ? { rights: [w.stamp] } : {}),
				})
			)
				throw Error(`the rights-first wake's delivery id ${id} is already known`);
			return true;
		});
	} catch (e) {
		d.log("rights-first-error", { deliveryId: row.deliveryId, first: id, error: String(e).slice(0, 200) });
		return undefined;
	}
	if (!done) {
		d.log("rights-first-skipped", { deliveryId: row.deliveryId, first: id, reason });
		return undefined;
	}
	crashPoint("rights-first-queued");
	d.log("rights-first", { deliveryId: row.deliveryId, first: id, reason });
	return store.wakes.find(id);
}

/** Whether the prerequisite cannot go now (not pending, owed, or backing off); the first time a row waits on it, the wait is logged. */
export function prerequisiteBlocked(r: Ctx, row: OutboxRow, first: OutboxRow, id: string): boolean {
	if (first.status === "pending" && !r.owed.has(first.id) && (r.notBefore.get(first.id) ?? -Infinity) <= r.clock())
		return false;
	if (!r.waitingOn.has(row.deliveryId)) {
		r.waitingOn.add(row.deliveryId);
		r.d.log("rights-first-waiting", { deliveryId: row.deliveryId, first: id, status: first.status });
	}
	return true;
}

/**
 * A prerequisite sent on its own (its row went, was cancelled, or is behind it in the pass) only while it is still for the state there is now:
 * one for an older state would put older rights after newer ones, so it is cancelled instead (`rights-first-obsolete`). True: send it.
 */
export async function current(
	r: Ctx,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
): Promise<boolean> {
	const { d, store } = r;
	if (store.wakes.find(row.deliveryId)?.status !== "pending") return false;
	const now = await readRightsNow(r, row, rightsNow);
	if (!now) return false;
	if (rightsFirstKey(row.deliveryId) === rightsStateKey(now)) return true;
	if (store.wakes.cancel(row.deliveryId, r.clock()) === "pending")
		d.log("rights-first-obsolete", { deliveryId: row.deliveryId });
	return false;
}

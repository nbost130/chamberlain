/** The rights a wake needs ahead of it: finding the prerequisite wake, queueing it, and sending it first. */
import { crashPoint } from "./crash.ts";
import { readRightsNow } from "./relay-compose.ts";
import { type Ctx, type Lane, type RelayDeps, type RightsNow, ROUNDS } from "./relay-ctx.ts";
import { send } from "./relay-send.ts";
import {
	loadRightsSent,
	needsRights,
	rightsFirstId,
	rightsFirstKey,
	rightsGap,
	rightsStateKey,
} from "./rights-sent.ts";
import type { Store } from "./store.ts";
import type { OutboxRow } from "./store-wakes.ts";

/**
 * What must be delivered before an attempt of a Steward row that depends on the Steward holding the rights (`needsRights`): asked before
 * EVERY attempt, retries and restarts included, never only once. Returns the rows delivered ahead of it on this attempt ([] when the durable
 * record already shows the Steward there now holds the rights in force now), or null when the row must not be sent on this pass: the state
 * could not be read, queueing failed, or the prerequisite is owed, backing off, failed this time or dead-lettered (the row waits, using no
 * attempt, until the operator retries it; cancelling a prerequisite makes the relay queue a fresh one, so giving up means cancelling the row).
 * When the rights cannot be read, a delivered prerequisite carrying the unreadable notice is enough: nothing can show more.
 */
async function ahead(
	r: Ctx,
	l: Lane,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
): Promise<OutboxRow[] | null> {
	const before: OutboxRow[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		const out = await aheadRound(r, l, row, rightsNow);
		if (out === "ready") return before;
		if (out === "stop") return null;
		before.push(...out);
		if (!r.d.lock.held()) return null;
	}
	return null;
}

/** One round of `ahead`: "ready" (nothing more is owed), "stop" (the row must not go now), or the prerequisite rows delivered in this round. */
async function aheadRound(
	r: Ctx,
	l: Lane,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
): Promise<"ready" | "stop" | OutboxRow[]> {
	const { store } = r;
	// The epoch is the database's, read now: from here to the prerequisite's enqueue nothing awaits, so its stamp has this epoch too.
	const now = await readRightsNow(r, row, rightsNow);
	if (!now) return "stop";
	const reason = rightsGap(loadRightsSent(store), now);
	if (!reason) {
		r.waitingOn.delete(row.deliveryId);
		return "ready";
	}
	const found = findPrerequisite(r, row, rightsStateKey(now));
	if (!found) return "stop";
	if (now.hash === undefined && found.delivered) return "ready";
	const first = store.wakes.find(found.id) ?? queuePrerequisite(r, row, now, { id: found.id, reason });
	if (!first || prerequisiteBlocked(r, row, first, found.id)) return "stop";
	const sent = await send(r, l, first, true);
	return sent.length ? sent : "stop";
}

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
function findPrerequisite(r: Ctx, row: OutboxRow, key: string): { id: string; delivered: boolean } | undefined {
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
function queuePrerequisite(
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
function prerequisiteBlocked(r: Ctx, row: OutboxRow, first: OutboxRow, id: string): boolean {
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

/** What goes before a row's own POST: `before` the prerequisite rows already delivered, and whether the row may go on. */
export async function sendPrerequisites(
	r: Ctx,
	l: Lane,
	row: OutboxRow,
	prerequisite: boolean,
): Promise<{ before: OutboxRow[]; go: boolean }> {
	const { rightsNow } = r.d;
	if (prerequisite || l.desk || !rightsNow) return { before: [], go: true };
	if (rightsFirstKey(row.deliveryId) && row.kind === "rights" && !(await current(r, row, rightsNow)))
		return { before: [], go: false };
	if (!needsRights(row.rights)) return { before: [], go: true };
	const went = await ahead(r, l, row, rightsNow);
	if (went === null) return { before: [], go: false };
	return { before: went, go: r.d.lock.held() };
}

/** One attempt of one row, counted and committed before the POST, and what follows an acceptance or a refusal. */
import { crashPoint } from "./crash.ts";
import type { WakeResult } from "./deliver.ts";
import { alarms } from "./messages.ts";
import type { Posted } from "./relay.ts";
import { deadLetter, land, readRightsNow } from "./relay-compose.ts";
import { type Ctx, type Lane, type RelayDeps, ROUNDS, raise } from "./relay-ctx.ts";
import { current, findPrerequisite, prerequisiteBlocked, queuePrerequisite } from "./relay-prereq.ts";
import { loadRightsSent, needsRights, rightsFirstKey, rightsGap, rightsStateKey } from "./rights-sent.ts";
import type { OutboxRow } from "./store-wakes.ts";

/**
 * One attempt of one row: counted and committed first, then the POST. The rows delivered: any prerequisite sent ahead of it, then the
 * row itself. It runs in the serial queue (see `serially`), the prerequisites and the row one after the other in the same job.
 */
export async function send(r: Ctx, l: Lane, row: OutboxRow, prerequisite = false): Promise<OutboxRow[]> {
	const { store } = r;
	if (!r.d.lock.held()) return [];
	if (row.attempts >= r.max) {
		deadLetter(r, l, row, row.attempts);
		return [];
	}
	const { before, go } = await sendPrerequisites(r, l, row, prerequisite);
	if (!go) return before;
	const n = store.tx(() => {
		const n = store.wakes.beginAttempt(row.id, r.clock());
		crashPoint("attempt-begun");
		return n;
	});
	if (n === undefined) return before;
	crashPoint("attempt-counted");
	const result = await r.post(l, row);
	const posted: Posted = { l, row, n, res: result, before };
	return result.ok ? accepted(r, posted) : refused(r, posted);
}

/** The transport accepted the POST: the row is owed its delivered commit, which lands now (the rows delivered include it only if it did). */
function accepted(r: Ctx, { l, row, n, res, before }: Posted): OutboxRow[] {
	crashPoint("accepted");
	r.owed.set(row.id, row);
	l.look.lastPostAt = r.clock();
	l.failures = 0;
	r.notBefore.delete(row.id);
	r.d.log("delivered", deliveredLog(l, row, n, res));
	return land(r, row) ? [...before, row] : before;
}

/** Pure: what the `delivered` log line says about a row: its attempt, kind, thread and receiver, and each member of a digest. */
function deliveredLog(l: Lane, row: OutboxRow, n: number, res: WakeResult): Record<string, unknown> {
	const [only] = row.members;
	const digest = row.members.length !== 1 || only?.deliveryId !== row.deliveryId;
	return {
		deliveryId: row.deliveryId,
		...(res.status !== undefined ? { http: res.status } : {}),
		attempt: n,
		queuedAt: row.createdAt,
		...(row.kind ? { kind: row.kind } : {}),
		...(row.thread ? { thread: row.thread } : {}),
		...(l.name ? { receiver: l.name } : {}),
		...(digest
			? {
					members: row.members.map((m) => ({
						deliveryId: m.deliveryId,
						queuedAt: m.queuedAt,
						...(m.kind ? { kind: m.kind } : {}),
						...(m.thread ? { thread: m.thread } : {}),
					})),
				}
			: {}),
	};
}

/** The POST failed: the attempt stays counted, the failure may raise the alarm, and the row is dead-lettered at the cap or waits its pause. */
function refused(r: Ctx, { l, row, n, res, before }: Posted): OutboxRow[] {
	r.d.log("deliver-error", {
		deliveryId: row.deliveryId,
		attempt: n,
		...(l.name ? { receiver: l.name } : {}),
		...(res.status !== undefined ? { http: res.status } : {}),
		...(res.error ? { error: res.error.slice(0, 200) } : {}),
	});
	if (++l.failures >= 2) raise(r, l.akey("wake-delivery"), alarms.wakeUnreachable(l.desk, l.failures, r.max));
	if (n >= r.max) deadLetter(r, l, row, n);
	else r.notBefore.set(row.id, r.clock() + r.pause(n));
	return before;
}

/** What goes before a row's own POST: `before` the prerequisite rows already delivered, and whether the row may go on. */
async function sendPrerequisites(
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

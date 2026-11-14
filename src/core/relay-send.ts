/** One attempt of one row, counted and committed before the POST, and what follows an acceptance or a refusal. */
import { crashPoint } from "./crash.ts";
import type { WakeResult } from "./deliver.ts";
import { alarms } from "./messages.ts";
import { type Posted, post } from "./relay.ts";
import { deadLetter, land } from "./relay-compose.ts";
import { type Ctx, type Lane, raise } from "./relay-ctx.ts";
import { sendPrerequisites } from "./relay-prereq.ts";
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
	const result = await post(l, row);
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

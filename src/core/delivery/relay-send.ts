/** One attempt of one row, counted and committed before the POST, and what follows an acceptance or a refusal. */
import { crashPoint } from "../crash.ts";
import { alarms } from "../messages.ts";
import { loadRightsSent, needsRights, rightsFirstKey, rightsGap, rightsStateKey } from "../steward/rights-sent.ts";
import { type GenSnapshot, snapshotGen } from "../steward/steward-gens.ts";
import { encodedSendBytes, exceedsEncodedCap, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import type { WakeResult } from "./deliver.ts";
import type { Posted } from "./relay.ts";
import { deadLetter, land, readRightsNow } from "./relay-compose.ts";
import { type Ctx, type Lane, type RelayDeps, ROUNDS, raise } from "./relay-ctx.ts";
import { current, findPrerequisite, prerequisiteBlocked, queuePrerequisite } from "./relay-prereq.ts";

/**
 * One attempt of one row: counted and committed first, then the POST. The rows delivered: any prerequisite sent ahead of it, then the
 * row itself. It runs in the serial queue (see `serially`), the prerequisites and the row one after the other in the same job.
 *
 * Steward lane: rights decision, CAS stamp and transport destination bind to ONE generation snapshot read before rights (B1).
 */
export async function send(r: Ctx, l: Lane, row: OutboxRow, prerequisite = false): Promise<OutboxRow[]> {
	const { store } = r;
	if (!r.d.lock.held()) return [];
	const snap = l.desk ? undefined : readSnap(r);
	const target = snap ? snap.wakeUrl : l.wake.target?.();
	if (!(await prepared(r, l, row, { threadId: snap?.thread, target }))) return [];
	if (!r.d.lock.held()) return [];
	if (!l.desk && !sameGen(snap, readSnap(r))) return [];
	if (row.attempts >= r.max) {
		deadLetter(r, l, row, row.attempts);
		return [];
	}
	// Encoded replay bound at the send gate: refuse on finalSendMessage size before rights/CAS/POST (R2).
	if (exceedsEncodedCap(row.message, row.deliveryId)) {
		refuseOversized(r, l, row);
		return [];
	}
	// Sample once before any awaited rights work so CAS and POST share the same generation.
	const { before, go } = await sendPrerequisites({ r, l, row, prerequisite, snap });
	if (!go) return before;
	// Generation moved during rights: do not POST under a stale rights decision; next pass rechecks.
	if (snap && !sameGen(snap, readSnap(r))) return before;
	const expectGen = l.desk ? undefined : snap?.gen;
	const n = store.tx(() => {
		const n = store.wakes.beginAttempt(row.id, r.clock(), expectGen);
		crashPoint("attempt-begun");
		return n;
	});
	if (n === undefined) return before;
	crashPoint("attempt-counted");
	const result = await r.post(l, row, target);
	const posted: Posted = { l, row, n, res: result, before };
	return result.ok ? accepted(r, posted) : refused(r, posted);
}

async function prepared(
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

/** Dead-letter an oversized pending row without POSTing; raise the bound alarm once. */
function refuseOversized(r: Ctx, l: Lane, row: OutboxRow): void {
	const maxBytes = TRANSFER_DIGEST_MAX_BYTES;
	const transfer = row.kind === "transfer";
	const event = transfer ? "transfer-oversized-dead-letter" : "digest-oversized-dead-letter";
	const alarmKey = transfer ? "transfer-oversized" : "digest-oversized";
	const alarmText = transfer
		? alarms.transferOversized([row.deliveryId], maxBytes)
		: alarms.digestOversized([row.deliveryId], maxBytes);
	if (r.store.wakes.finish(row.id, "dead_letter", r.clock())) {
		r.d.log(event, {
			deliveryId: row.deliveryId,
			bytes: encodedSendBytes(row.message, row.deliveryId),
			maxBytes,
		});
		r.notBefore.delete(row.id);
		r.owed.delete(row.id);
		if (!r.reported.has(row.deliveryId)) {
			r.reported.add(row.deliveryId);
			raise(r, l.akey(alarmKey), alarmText);
		}
	}
}

function readSnap(r: Ctx): GenSnapshot | undefined {
	return r.d.genSnapshot ? r.d.genSnapshot() : snapshotGen(r.store, r.d.conf);
}

function sameGen(a: GenSnapshot | undefined, b: GenSnapshot | undefined): boolean {
	return a?.gen === b?.gen;
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
		// A lone held wake keeps the time it was held, not the time it was composed, so its wait counts in queue-waits.
		queuedAt: digest ? row.createdAt : (only?.queuedAt ?? row.createdAt),
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

/** The POST failed: the attempt stays counted, attempt_gen is cleared, the failure may raise the alarm, and the row is dead-lettered at the cap or waits its pause. */
function refused(r: Ctx, { l, row, n, res, before }: Posted): OutboxRow[] {
	r.store.tx(() => r.store.steward.clearAttemptGen(row.id));
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

type PrereqArgs = {
	r: Ctx;
	l: Lane;
	row: OutboxRow;
	prerequisite: boolean;
	snap: GenSnapshot | undefined;
};

/** What goes before a row's own POST: `before` the prerequisite rows already delivered, and whether the row may go on. */
async function sendPrerequisites(a: PrereqArgs): Promise<{ before: OutboxRow[]; go: boolean }> {
	const { r, l, row, prerequisite, snap } = a;
	const { rightsNow } = r.d;
	if (prerequisite || l.desk || !rightsNow) return { before: [], go: true };
	if (rightsFirstKey(row.deliveryId) && row.kind === "rights" && !(await current(r, row, rightsNow)))
		return { before: [], go: false };
	if (!needsRights(row.rights)) return { before: [], go: true };
	const went = await ahead({ r, l, row, rightsNow, snap });
	if (went === null) return { before: [], go: false };
	return { before: went, go: r.d.lock.held() };
}

type AheadArgs = {
	r: Ctx;
	l: Lane;
	row: OutboxRow;
	rightsNow: NonNullable<RelayDeps["rightsNow"]>;
	snap: GenSnapshot | undefined;
};

/** One round of `ahead`: "ready" (nothing more is owed), "stop" (the row must not go now), or the prerequisite rows delivered in this round. */
async function aheadRound(a: AheadArgs): Promise<"ready" | "stop" | OutboxRow[]> {
	const { r, l, row, rightsNow, snap } = a;
	const { store } = r;
	const now = await readRightsNow(r, row, () => rightsNow(snap ? { steward: snap.thread } : undefined));
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
 * What must be delivered before an attempt of a Steward row that depends on the Steward holding the rights (`needsRights`).
 */
async function ahead(a: AheadArgs): Promise<OutboxRow[] | null> {
	const before: OutboxRow[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		const out = await aheadRound(a);
		if (out === "ready") return before;
		if (out === "stop") return null;
		before.push(...out);
		if (!a.r.d.lock.held()) return null;
	}
	return null;
}

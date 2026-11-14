/** Landing a delivered row, dead-lettering one, composing the held wakes into a digest, and the serial queue every send runs in. */
import { crashPoint } from "./crash.ts";
import { composeWake, observe } from "./hold.ts";
import type { Ctx, Lane, RelayDeps, RightsNow } from "./relay-ctx.ts";
import { flagDead } from "./relay-pass.ts";
import { epochOf, RIGHTS_SENT_KEY, recordOf, rightsEpoch } from "./rights-sent.ts";
import type { Composed, HeldItem, OutboxRow, RightsStamp } from "./store-wakes.ts";

/**
 * The row's delivered commit. False while it cannot commit (the row stays owed). A Steward row with a `full` stamp (it carried the whole
 * block) writes the rights record from that stamp in the SAME transaction: the record says what the Steward holds exactly when a delivered
 * row proves it, and a crash cannot leave one without the other. A redelivery after a crash writes it the same way. An accepted POST of a row
 * the operator cancelled meanwhile still reached the Steward, so it writes the record too.
 * Only while the stamp's epoch is still the current one: a full block composed before a compaction or a shrink bumped the epoch (a wake in
 * flight when the compaction was asked for, or one owed across it) is marked delivered and writes nothing, so it can never restore a record
 * the compaction took away (`rights-full-stale`).
 */
export function land(r: Ctx, row: OutboxRow): boolean {
	const { d, store } = r;
	const full = row.receiver ? undefined : row.rights?.filter((s) => s.full).at(-1);
	let stale: number | undefined;
	try {
		const done = store.tx(() => {
			const done = store.wakes.finish(row.id, "delivered", r.clock());
			if (full) {
				const current = rightsEpoch(store);
				if (epochOf(full) === current) store.state.set(RIGHTS_SENT_KEY, { ...recordOf(full), epoch: current });
				else stale = current;
			}
			return done;
		});
		if (!done) d.log("delivered-after-cancel", { deliveryId: row.deliveryId });
		if (stale !== undefined)
			d.log("rights-full-stale", { deliveryId: row.deliveryId, epoch: epochOf(full), current: stale });
	} catch (e) {
		d.log("delivered-record-failed", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
		return false;
	}
	r.owed.delete(row.id);
	crashPoint("delivered");
	for (const m of row.members) {
		try {
			d.onDelivered?.(m.deliveryId);
		} catch (e) {
			d.log("on-delivered-error", { deliveryId: m.deliveryId, error: String(e).slice(0, 200) });
		}
	}
	return true;
}

export function deadLetter(r: Ctx, l: Lane, row: OutboxRow, attempts: number) {
	if (r.store.wakes.finish(row.id, "dead_letter", r.clock()))
		r.d.log("deliver-dead-letter", { deliveryId: row.deliveryId, attempts, ...(l.name ? { receiver: l.name } : {}) });
	r.notBefore.delete(row.id);
	flagDead(r, l);
}

/** A receiver's held wakes become ONE row when that receiver may take a wake. */
export function compose(r: Ctx, l: Lane, now: number) {
	const { d, store } = r;
	if (!store.wakes.held(l.name).length) return;
	const look = observe(l.look, l.gate(), now, r.ceiling);
	if (!look.post) return;
	const row = store.wakes.compose(now, (held) => digestOf(l, held, now), l.name);
	if (!row) return;
	crashPoint("composed");
	if (look.forced) l.look.lastForcedAt = now;
	d.log("composed", {
		deliveryId: row.deliveryId,
		members: row.members.map((m) => m.deliveryId),
		folded: row.folded,
		...(look.forced ? { forced: "ceiling" } : {}),
	});
}

/** Pure: the row a receiver's held wakes freeze into: the composed text and members, the kind and thread of a single item (else a digest), the receiver, and the members' stamps. */
function digestOf(l: Lane, held: HeldItem[], now: number): Composed {
	const { kept, ...c } = composeWake(held, now);
	const only = held.length === 1 ? held[0] : undefined;
	return {
		...c,
		...(only
			? { ...(only.kind ? { kind: only.kind } : {}), ...(only.thread ? { thread: only.thread } : {}) }
			: { kind: "digest" }),
		...(l.name ? { receiver: l.name } : {}),
		...digestStamps(held, c.members, kept),
	};
}

/**
 * Pure: the stamps a digest carries, as `{ rights }` (none: `{}`). The digest carries its members' stamps: a pointer or legacy stamp makes the
 * whole digest depend on the record (it is checked as one row), and a full stamp is kept only from an item whose text is in the digest (a
 * folded item's text is not sent, so its block is not).
 */
function digestStamps(held: HeldItem[], members: string[], kept: string[]): { rights?: RightsStamp[] } {
	const stamps = new Map<string, RightsStamp>();
	for (const h of held)
		if (members.includes(h.deliveryId))
			for (const st of h.rights ?? []) if (!st.full || kept.includes(h.deliveryId)) stamps.set(JSON.stringify(st), st);
	return stamps.size ? { rights: [...stamps.values()] } : {};
}

/**
 * The one serial queue every transport POST goes through, a wake of any receiver or a compaction: each job starts only when the one before it has settled
 * (resolved, rejected or timed out: the transports have a deadline), so the webhook never has two requests in flight. A job's failure is
 * its caller's, never the queue's.
 */
export function serially<T>(r: Ctx, job: () => Promise<T>): Promise<T> {
	const run = r.run.queueTail.then(job);
	r.run.queueTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** The Steward and rights there are now, with the epoch read from the database; a failed read is logged against the row and gives none. */
export async function readRightsNow(
	r: Ctx,
	row: OutboxRow,
	rightsNow: NonNullable<RelayDeps["rightsNow"]>,
): Promise<RightsNow | undefined> {
	try {
		return { ...(await rightsNow()), epoch: rightsEpoch(r.store) };
	} catch (e) {
		r.d.log("rights-first-error", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
		return undefined;
	}
}

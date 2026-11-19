/** Landing a delivered row, dead-lettering one, composing the held wakes into a digest, and the serial queue every send runs in. */
import { crashPoint } from "../crash.ts";
import { type composeWake, debouncing, observe, overdue, type ThreadNews } from "../decide/hold.ts";
import { composeDigestBatch } from "../decide/hold-digest-batch.ts";
import { scrubSecretHeldMessages } from "../items/questions-claim.ts";
import { alarms } from "../messages.ts";
import { epochOf, RIGHTS_SENT_KEY, recordOf, rightsEpoch } from "../steward/rights-sent.ts";
import {
	composeTransferBatch,
	deadLetterOversizedDigests,
	deadLetterOversizedTransfers,
} from "../steward/steward-transfer.ts";
import { TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { Composed, HeldItem, OutboxRow, RightsStamp } from "../store/store-wakes.ts";
import { type Ctx, type InlineRights, type Lane, type RelayDeps, type RightsNow, raise } from "./relay-ctx.ts";

/**
 * The row's delivered commit. False while it cannot commit (the row stays owed). A Steward row with a `full` stamp (it carried the whole
 * block) writes the rights record from that stamp in the SAME transaction: the record says what the Steward holds exactly when a delivered
 * row proves it, and a crash cannot leave one without the other. A redelivery after a crash writes it the same way. An accepted POST of a row
 * the operator cancelled meanwhile still reached the Steward, so it writes the record too.
 * Only while the stamp's epoch is still the current one: a full block composed before a compaction or a shrink bumped the epoch (a wake in
 * flight when the compaction was asked for, or one owed across it) is marked delivered and writes nothing, so it can never restore a record
 * the compaction took away (`rights-full-stale`).
 * `inline` is the block that rode inside this row's POST (`rightsInline`, or a stale full block replaced): its stamp writes the record exactly as a standalone full wake would, and without one nothing is written.
 * `alongside` runs inside the same transaction and returns the row of held news that rode in the same POST (relay-carry.ts `bindCarried`): it is
 * bound delivered in the same commit as the wake, so a crash can never leave the wake recorded and its news still held (to go again), or the
 * reverse. If it throws, nothing commits and the row stays owed.
 */
export function land(r: Ctx, row: OutboxRow, inline?: InlineRights, alongside?: () => OutboxRow | undefined): boolean {
	const { d, store } = r;
	// The block that rode inside the POST is the one the Steward holds now (none at all when the rights could not be read): never the row's own, older one.
	const full = row.receiver ? undefined : inline ? inline.stamp : row.rights?.filter((s) => s.full).at(-1);
	let stale: number | undefined;
	let carried: OutboxRow | undefined;
	try {
		const done = store.tx(() => {
			// Read attempt_gen before finish: the in-memory row is often the pre-attempt snapshot (A1).
			const stamped = store.wakes.find(row.deliveryId)?.attemptGen ?? row.attemptGen;
			const done = store.wakes.finish(row.id, "delivered", r.clock());
			if (done && !row.receiver) {
				const gen = stamped ?? store.steward.maxGen();
				if (gen >= 1) store.steward.insertLedger({ outboxId: row.id, gen, origin: "live" });
			}
			if (full) {
				const current = rightsEpoch(store);
				if (epochOf(full) === current) store.state.set(RIGHTS_SENT_KEY, { ...recordOf(full), epoch: current });
				else stale = current;
			}
			carried = alongside?.();
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
	r.landing.delete(row.id);
	crashPoint("delivered");
	for (const m of [...row.members, ...((carried as OutboxRow | undefined)?.members ?? [])]) {
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

/**
 * Whether a forced digest uses up the ceiling's window. The ceiling's own always does. An answer's deadline does too, so the ceiling sends no
 * second turn right behind it, unless transfers are held: the answer's digest never carries them, so they keep their ceiling and recurring
 * answers cannot starve them.
 */
const usesWindow = (ceiling: boolean, due: boolean, held: HeldItem[]): boolean =>
	ceiling || (due && !held.some((h) => h.kind === "transfer"));

/**
 * Idle news (turn ends, notes, sweeps) waits a few minutes for company (hold.ts `debouncing`), so several go as one digest, one Steward turn
 * instead of several. Logged once per batch (`wake-debounced`). Never the ceiling's own pass or an answer's deadline: the caller only asks otherwise.
 */
function waitForCompany(
	r: Ctx,
	held: HeldItem[],
	now: number,
	{ look, due }: { look: { post: boolean; forced: boolean }; due: boolean },
): boolean {
	const ms = r.d.debounceMs ?? 0;
	const ordinary = look.post && !look.forced && !due;
	if (!ordinary || !debouncing(held, now, ms)) return false;
	const first = held.reduce((a, h) => (h.queuedAt < a.queuedAt ? h : a));
	if (!r.reported.has(`debounce:${first.deliveryId}`)) {
		r.reported.add(`debounce:${first.deliveryId}`);
		r.d.log("wake-debounced", { held: held.length, oldest: first.deliveryId, forMs: ms });
	}
	return true;
}

/** The lane's held wakes, none at all while news that rode in a wake whose delivered commit is still owed is among them: it is bound when that lands, never composed again meanwhile. */
function heldToCompose(r: Ctx, l: Lane): HeldItem[] {
	const held = r.store.wakes.held(l.name);
	return held.some((h) => [...r.landing.values()].some((g) => g.carried?.members.includes(h.deliveryId))) ? [] : held;
}

/** A receiver's held wakes become ONE row when that receiver may take a wake. */
export function compose(r: Ctx, l: Lane, now: number) {
	const { d, store } = r;
	if (!store.wakes.held(l.name).length) return;
	// Oversized solo transfers never enter a batch: dead-letter with alarm before compose (R2).
	deadLetterOversizedTransfers(r, l, now);
	// Oversized solo held wakes never enter a digest batch: dead-letter before compose.
	deadLetterOversizedDigests(r, l, now);
	const heldNow = heldToCompose(r, l);
	if (!heldNow.length) return;
	// Only unbatchable (oversized) transfers remain: wait — never compose an empty digest.
	const transfers = heldNow.filter((h) => h.kind === "transfer");
	const others = heldNow.filter((h) => h.kind !== "transfer");
	if (transfers.length && !others.length && !composeTransferBatch(transfers, now)) return;
	if (others.length && !transfers.length && !composeDigestBatch(others, now)) return;
	const look = observe(l.look, l.gate(), now, r.ceiling);
	// A held answer past its own short ceiling goes now, with everything held beside it, however busy the receiver is.
	const due = !look.post && overdue(heldNow, now);
	if (!look.post && !due) return;
	if (waitForCompany(r, heldNow, now, { look, due })) return;
	let kept: string[] = [];
	const row = store.wakes.compose(
		now,
		(held) =>
			digestOf(l, scrubSecretHeldMessages(store, held), now, {
				onKept: (k) => (kept = k),
				answerDue: due,
				news: r.news,
			}),
		l.name,
	);
	if (!row) return;
	crashPoint("composed");
	if (usesWindow(look.forced, due, heldNow)) l.look.lastForcedAt = now;
	d.log("composed", {
		deliveryId: row.deliveryId,
		members: row.members.map((m) => m.deliveryId),
		kept,
		folded: row.folded,
		...(look.forced ? { forced: "ceiling" } : due ? { forced: "answer" } : {}),
	});
}

function withMeta(
	l: Lane,
	use: HeldItem[],
	composed: ReturnType<typeof composeWake>,
	onKept: (kept: string[]) => void,
): Composed {
	const { kept, ...c } = composed;
	onKept(kept);
	const only = use.length === 1 ? use[0] : undefined;
	return {
		...c,
		...(only
			? { ...(only.kind ? { kind: only.kind } : {}), ...(only.thread ? { thread: only.thread } : {}) }
			: { kind: "digest" }),
		...(l.name ? { receiver: l.name } : {}),
		...digestStamps(use, c.members, kept),
	};
}

/**
 * Pure: the row a receiver's held wakes freeze into.
 * Transfer items compose alone under the encoded-byte cap (V2-M1/M1); mixed ordinary traffic never expands a replay digest.
 * Overflow transfers and ordinary held wakes stay held for later passes.
 */
export function digestOf(
	l: Lane,
	held: HeldItem[],
	now: number,
	{
		onKept,
		answerDue,
		news,
		maxBytes = TRANSFER_DIGEST_MAX_BYTES,
	}: {
		onKept: (kept: string[]) => void;
		answerDue: boolean;
		news?: (thread: string) => ThreadNews | undefined;
		/** The bound the digest must fit in: less than the full one when it shares a POST with an immediate wake. */
		maxBytes?: number;
	},
): Composed {
	const transfers = held.filter((h) => h.kind === "transfer");
	const others = held.filter((h) => h.kind !== "transfer");
	const transferBatch = transfers.length ? composeTransferBatch(transfers, now) : undefined;
	const digestBatch = others.length ? composeDigestBatch(others, now, maxBytes, news ? { news } : {}) : undefined;
	const useTransfers = transferBatch && (!digestBatch || transfersFirst(transfers, others, answerDue));
	if (useTransfers) {
		const use = transfers.filter((h) => transferBatch.members.includes(h.deliveryId));
		return withMeta(l, use, transferBatch, onKept);
	}
	if (!digestBatch) throw new Error("digestOf: no batch under encoded cap");
	const use = others.filter((h) => digestBatch.members.includes(h.deliveryId));
	return withMeta(l, use, digestBatch, onKept);
}

/**
 * Pure: whether a transfer batch goes ahead of the ordinary held wakes. Never when an answer's deadline forced the digest: that answer must be
 * in it, or every poll would force another batch while it stays held and overdue. Otherwise the class holding the oldest wake goes first, so a
 * long transfer backlog after a Steward switch cannot starve turn ends and sweeps for hours, and new turn ends cannot starve the transfers.
 */
function transfersFirst(transfers: HeldItem[], others: HeldItem[], answerDue: boolean): boolean {
	if (answerDue) return false;
	const oldest = (xs: HeldItem[]) => Math.min(...xs.map((h) => h.queuedAt));
	return oldest(transfers) <= oldest(others);
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

/** A receiver's dead letters raise its `wake-dead-letter` alarm until the operator retries or cancels them. */
export function flagDead(r: Ctx, l: Lane) {
	const dead = r.store.wakes.rows("dead_letter", l.name);
	if (!dead.length) return;
	for (const w of dead)
		if (!r.reported.has(w.deliveryId)) {
			r.reported.add(w.deliveryId);
			r.d.log("deliver-dead-letter-reported", { deliveryId: w.deliveryId, attempts: w.attempts });
		}
	raise(
		r,
		l.akey("wake-dead-letter"),
		alarms.wakeDeadLetters(
			l.desk,
			dead.map((w) => w.deliveryId),
			r.max,
		),
	);
}

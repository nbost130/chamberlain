/**
 * The message relay of the transactional outbox: the ONLY code that calls a wake transport (`wake`, and `compact` through `relay.compact`),
 * and it runs in the daemon alone (one daemon per state directory, enforced by singleton.ts). It cannot be built without the held lock:
 * `createRelay` requires the handle `holdRelayLock` returned and refuses anything else, and refuses a handle that is not the lock on the
 * database file its store opened, in the directory the lock is on (the handle records both devices and inodes; `lockCovers`), and it sends
 * nothing once that lock is released.
 * Producers (the engine, the sweep, the page, `synthetic-wake.ts`) only insert rows (deliver.ts); `wakes.ts` only changes a row's status;
 * no other process talks to the webhook. src/architecture.test.ts fails if another module calls a transport or POSTs.
 *
 * ONE relay per lock, so one per store and per process (`createRelay` refuses a second relay on a lock that already has one), and it sends
 * for every receiver: the Steward (rows with no receiver) and each named receiver it is given (`receivers`, the Alert Desk's "desk"). Each
 * row's receiver column (migration 8) picks its transport; each receiver has its own gate, failure count, alarms and per-receiver order, and
 * every POST of every receiver goes through the relay's ONE serial queue, so no two requests are ever in flight at once.
 *
 * Each pass, a short poll (CHAMBERLAIN_RELAY_POLL_MS, default 1 s) or a nudge from a producer in this process:
 *   1. Held wakes are composed, per receiver, into ONE row when that receiver is idle or has been busy for the ceiling (hold.ts): one
 *      transaction freezes the row's delivery id, text and members, and binds each held item to it for good.
 *   2. Each pending row, oldest first, is sent: attempts + 1 is COMMITTED, then the POST, then the row is committed `delivered`.
 *
 * The guarantee: at-least-once with bounded retries: a row is POSTed until one POST is accepted or it has used `maxAttempts` attempts, and
 * never more than `maxAttempts` POSTs between operator retries, every one under the row's frozen delivery id. An attempt is not a POST: it
 * is counted before the POST, so a crash in between spends one with nothing sent, and a row can be dead-lettered with zero POSTs. Every
 * outcome counts (an accepted POST, a refusal, a 5xx, a timeout), and none is given back. A row that used its last attempt without being
 * delivered is dead-lettered (kept, alarmed) until the operator retries or cancels it (wakes-cli.ts). Sends are one at a time, in row
 * order with backoff skips (not strict order), so a slow send delays the rows behind it. An
 * accepted POST whose delivered commit fails is never POSTed again by this process: the commit is retried on every pass. Only a process
 * that exits before that commit leaves the row pending, and the restart sends it again under the same id, counted like any other attempt.
 */
import { crashPoint } from "./crash.ts";
import { maxAttemptsFromEnv, type WakeResult, withDeliveryId } from "./deliver.ts";
import { HOLD_CEILING_MS } from "./hold.ts";
import { audit } from "./relay-audit.ts";
import { serially } from "./relay-compose.ts";
import {
	type Ctx,
	type Lane,
	laneOf,
	makeLane,
	type RelayDeps,
	relayed,
	relayPollMs,
	retryAfterMs,
} from "./relay-ctx.ts";
import { pass } from "./relay-pass.ts";
import { invalidateRights } from "./rights-sent.ts";
import { isRelayLock, lockCovers } from "./singleton.ts";
import type { Store } from "./store.ts";
import type { OutboxRow } from "./store-wakes.ts";

/** The relay refuses a lock that is not held, not on this store's database, or already has a relay. */
function assertRelayLock(d: RelayDeps, store: Store): void {
	if (!isRelayLock(d.lock) || !d.lock.held())
		throw new Error(
			"createRelay needs the one-relay lock, held: take it first (singleton.ts) and pass the handle it returns",
		);
	// The handle must be the lock on THIS store's database file: a lock held on some other database authorizes nothing here.
	if (!lockCovers(d.lock, store.path))
		throw new Error(
			`createRelay was given a lock that is not on this store's database: the lock handle is for ${d.lock.path}, the store is ${store.path}. Take the lock on the very database file the store opened.`,
		);
	// One relay per lock: a second relay would be a second POST queue beside the first. Every receiver is a lane of this one (`receivers`).
	if (relayed.has(d.lock))
		throw new Error(
			"createRelay: a relay already exists on this lock, and there is one relay per store. Send another receiver's wakes through that relay (`receivers`), never a second one.",
		);
}

function relayContext(d: RelayDeps): Ctx {
	const { store } = d;
	assertRelayLock(d, store);
	relayed.add(d.lock);
	const steward = makeLane(null, d.wake, d.gate);
	const named = Object.entries(d.receivers ?? {}).map(([name, rc]) => makeLane(name, rc.wake, rc.gate));
	const max =
		d.maxAttempts !== undefined && Number.isInteger(d.maxAttempts) && d.maxAttempts >= 1
			? d.maxAttempts
			: maxAttemptsFromEnv();
	return {
		d,
		store,
		lanes: [steward, ...named],
		max,
		pause: d.retryAfterMs ?? retryAfterMs,
		ceiling: d.ceilingMs ?? HOLD_CEILING_MS,
		clock: () => d.now?.() ?? Date.now(),
		post,
		owed: new Map(),
		notBefore: new Map(),
		unrouted: new Set(),
		waitingOn: new Set(),
		reported: new Set(),
		run: {
			lockLost: false,
			queueTail: Promise.resolve(),
			chain: Promise.resolve([]),
			next: undefined,
			timer: undefined,
		},
	};
}

export function createRelay(d: RelayDeps) {
	const r = relayContext(d);
	return {
		pass: () => pass(r),
		audit: () => audit(r),
		compact: (deliveryId: string) => compact(r, deliveryId),
		/** Whether the adapter has a compaction target that can take a request now. */
		compactReady: () => Boolean(d.compact?.ready()),
		/** Failed attempts in a row: the Steward's, or a named receiver's. */
		failures: (receiver?: string) => laneOf(r, receiver)?.failures ?? 0,
		/** Starts the poll. Resolves when the first pass (startup recovery) is done. */
		start(pollMs = relayPollMs()) {
			r.run.timer ??= setInterval(() => {
				void pass(r);
			}, pollMs);
			return pass(r);
		},
		async stop() {
			clearInterval(r.run.timer);
			r.run.timer = undefined;
			await r.run.chain;
			await r.run.queueTail;
		},
	};
}

/** The POST of one row under its frozen delivery id; a transport that throws is a failed attempt with its message. */
async function post(l: Lane, row: OutboxRow): Promise<WakeResult> {
	try {
		return await l.wake.send(row.deliveryId, withDeliveryId(row.message, row.deliveryId));
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** One attempt's outcome: the lane and row, which attempt it was, what the transport answered, and the rows already delivered ahead of it. */
export type Posted = { l: Lane; row: OutboxRow; n: number; res: WakeResult; before: OutboxRow[] };

/**
 * One compaction request to the Steward's compaction task: a single attempt, no row (the task's prompt is /compact, so it takes no message),
 * and it throws when it cannot be sent. It lives here so that the relay is the only code that calls a transport, and it waits its turn in
 * the same serial queue as the wakes (a compaction is not a row, so it is not retried, but it is never beside another POST).
 *
 * The rights record is invalidated HERE, inside the serial job, before the POST: the epoch is bumped and the record dropped in one write
 * (`invalidateRights`). Every wake job queued before this one has settled by now, so a full block in flight when the compaction was asked for
 * has already landed (and is dropped by the bump), or lands later from `owed` under the old epoch (and writes nothing). Every full stamp
 * composed after the bump carries the new epoch and is POSTed in a later job, after the compaction. If the bump fails, nothing is sent.
 */
function compact(r: Ctx, deliveryId: string): Promise<WakeResult> {
	const { d, store } = r;
	// Queued behind any wake in flight, and checked when it is its turn: the lock may have been released while it waited.
	return serially(r, async () => {
		if (!d.lock.held()) throw new Error("the relay no longer holds the one-relay lock: nothing is sent");
		if (!d.compact) throw new Error("this adapter has no compaction target");
		const epoch = invalidateRights(store);
		d.log("rights-invalidated", { reason: "compaction", deliveryId, epoch });
		crashPoint("compact-invalidated");
		return d.compact.send(deliveryId, "");
	});
}

/** The relay as `createRelay` returns it. */
export type Relay = ReturnType<typeof createRelay>;

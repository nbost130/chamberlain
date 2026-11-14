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
import { maxAttemptsFromEnv, STALE_AFTER_MS, type WakeResult, type WakeTransport, withDeliveryId } from "./deliver.ts";
import { composeWake, type Gate, HOLD_CEILING_MS, observe } from "./hold.ts";
import { type AlarmText, alarms } from "./messages.ts";
import {
	epochOf,
	invalidateRights,
	loadRightsSent,
	needsRights,
	RIGHTS_SENT_KEY,
	type RightsState,
	recordOf,
	rightsEpoch,
	rightsFirstId,
	rightsFirstKey,
	rightsGap,
	rightsStateKey,
} from "./rights-sent.ts";
import { isRelayLock, lockCovers, type RelayLock } from "./singleton.ts";
import type { HoldClock, OutboxRow, RightsStamp, Store } from "./store.ts";

/** The pause before a failed row is tried again: one minute, then four, so a webhook back within about five minutes loses nothing. */
export const retryAfterMs = (attempts: number) => Math.min(60_000 * 4 ** (attempts - 1), 15 * 60_000);
/** CHAMBERLAIN_RELAY_POLL_MS if it is a positive number, else one second. */
export const relayPollMs = (env: Record<string, string | undefined> = process.env) => {
	const n = Number(env.CHAMBERLAIN_RELAY_POLL_MS);
	return n > 0 ? n : 1000;
};

export type RelayDeps = {
	store: Store;
	/**
	 * The held one-relay lock (`holdRelayLock`, singleton.ts). Required, and checked: the relay is the only code that calls a wake transport,
	 * and it cannot be built without the lock that makes it the only relay. It must be the lock on this store's database file (`lockCovers`).
	 * It sends nothing once the lock is released.
	 */
	lock: RelayLock;
	/** The way a wake reaches the Steward (`Adapter.wake`): rows with no receiver. */
	wake: WakeTransport;
	/**
	 * The other receivers this relay sends for, by the name in a row's receiver column ("desk": `Adapter.alertDesk`). Each has its own
	 * transport (a different webhook) and its own gate, so a busy desk holds only the desk's wakes; every POST still goes through the one
	 * serial queue. A row whose receiver is not here is never sent to another receiver's webhook: it waits (and is logged once).
	 */
	receivers?: Record<string, { wake: WakeTransport; gate: () => Gate }>;
	/** The way a compaction reaches the Steward's compaction task (`Adapter.compact`), if the adapter has one. Sent only through `relay.compact`. */
	compact?: WakeTransport;
	/** The Steward's thread, read fresh: held wakes are composed when it is idle (or at the ceiling). */
	gate: () => Gate;
	log: (event: string, data?: Record<string, unknown>) => void;
	alarm: (key: string, title: string, summary: string) => void;
	/**
	 * The Steward and the rights in force now (`RightsState`: no `hash` when the rights cannot be read), and the standalone full-rights wake for
	 * that state, the prerequisite. Asked before EVERY attempt of a Steward row that depends on the Steward already holding the rights (a pointer
	 * or legacy stamp, `needsRights`), retries and restarts included. The row goes only when the durable rights record shows that state;
	 * otherwise the prerequisite for that state is queued (`<id>:rights-first:<state key>`, once per row and state: the outbox refuses a known
	 * id) and sent first, and the row follows EXACTLY as it was queued: no row's text is ever rewritten or searched. The prerequisite carries a
	 * `full` stamp, so its delivery writes the record in the transaction that marks it delivered. Absent: such rows are sent as they are.
	 */
	rightsNow?: () => Promise<RightsState & { wake: (forId: string) => { message: string; stamp?: RightsStamp } }>;
	/** Runs for each delivery id a row carries, right after the row is committed delivered. Idempotent: recovery may run it again. */
	onDelivered?: (deliveryId: string) => void;
	/** Attempts per row before it is dead-lettered (default CHAMBERLAIN_MAX_ATTEMPTS, else 3). */
	maxAttempts?: number;
	retryAfterMs?: (attempts: number) => number;
	ceilingMs?: number;
	staleAfterMs?: number;
	now?: () => number;
};

/** The lock handles a relay has been built on. One relay per handle, for good: with `holdRelayLock` refusing a second lock in a process, that is one relay per store and per process. */
const relayed = new WeakSet<RelayLock>();

/** One receiver the relay sends for: its rows and held wakes (`name`, `null` for the Steward's), its transport and gate, and its own counters. */
type Lane = {
	name: string | null;
	wake: WakeTransport;
	gate: () => Gate;
	look: HoldClock;
	failures: number;
	notReadyAt: number;
	desk: boolean;
	akey: (k: string) => string;
};

export function createRelay(d: RelayDeps) {
	const { store } = d;
	/** Raises an alarm whose words are in messages.ts. */
	const raise = (key: string, a: AlarmText) => d.alarm(key, a.title, a.summary);
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
	relayed.add(d.lock);
	const clock = () => d.now?.() ?? Date.now();
	/** Alarm keys and titles of a named receiver say whose wakes they are, so the desk's alarm never silences the Steward's. */
	const lane = (name: string | null, wake: WakeTransport, gate: () => Gate): Lane => ({
		name,
		wake,
		gate,
		look: {},
		failures: 0,
		notReadyAt: -Infinity,
		desk: name !== null,
		akey: (k) => (name ? `${name}:${k}` : k),
	});
	const steward = lane(null, d.wake, d.gate);
	const lanes: Lane[] = [steward, ...Object.entries(d.receivers ?? {}).map(([name, r]) => lane(name, r.wake, r.gate))];
	const laneOf = (receiver: string | undefined) => lanes.find((l) => l.name === (receiver ?? null));
	const max =
		d.maxAttempts !== undefined && Number.isInteger(d.maxAttempts) && d.maxAttempts >= 1
			? d.maxAttempts
			: maxAttemptsFromEnv();
	const pause = d.retryAfterMs ?? retryAfterMs;
	const ceiling = d.ceilingMs ?? HOLD_CEILING_MS;
	/** Rows the transport accepted whose delivered commit has not landed: never POSTed again, the commit is retried every pass. */
	const owed = new Map<number, OutboxRow>();
	/** When a failed row may be tried again. In memory: a restart tries every pending row at once (each try is still counted). */
	const notBefore = new Map<number, number>();
	let lockLost = false;
	/** Rows whose receiver this relay has no transport for, already logged. */
	const unrouted = new Set<number>();

	/**
	 * The row's delivered commit. False while it cannot commit (the row stays owed). A Steward row with a `full` stamp (it carried the whole
	 * block) writes the rights record from that stamp in the SAME transaction: the record says what the Steward holds exactly when a delivered
	 * row proves it, and a crash cannot leave one without the other. A redelivery after a crash writes it the same way. An accepted POST of a row
	 * the operator cancelled meanwhile still reached the Steward, so it writes the record too.
	 * Only while the stamp's epoch is still the current one: a full block composed before a compaction or a shrink bumped the epoch (a wake in
	 * flight when the compaction was asked for, or one owed across it) is marked delivered and writes nothing, so it can never restore a record
	 * the compaction took away (`rights-full-stale`).
	 */
	function land(row: OutboxRow): boolean {
		const full = row.receiver ? undefined : row.rights?.filter((s) => s.full).at(-1);
		let stale: number | undefined;
		try {
			const done = store.tx(() => {
				const done = store.wakes.finish(row.id, "delivered", clock());
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
		owed.delete(row.id);
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

	function deadLetter(l: Lane, row: OutboxRow, attempts: number) {
		if (store.wakes.finish(row.id, "dead_letter", clock()))
			d.log("deliver-dead-letter", { deliveryId: row.deliveryId, attempts, ...(l.name ? { receiver: l.name } : {}) });
		notBefore.delete(row.id);
		flagDead(l);
	}

	/** A receiver's held wakes become ONE row when that receiver may take a wake. */
	function compose(l: Lane, now: number) {
		if (!store.wakes.held(l.name).length) return;
		const look = observe(l.look, l.gate(), now, ceiling);
		if (!look.post) return;
		const row = store.wakes.compose(
			now,
			(held) => {
				const { kept, ...c } = composeWake(held, now);
				const only = held.length === 1 ? held[0]! : undefined;
				// The digest carries its members' stamps: a pointer or legacy stamp makes the whole digest depend on the record (it is checked as one
				// row), and a full stamp is kept only from an item whose text is in the digest (a folded item's text is not sent, so its block is not).
				const stamps = new Map<string, RightsStamp>();
				for (const h of held)
					if (c.members.includes(h.deliveryId))
						for (const st of h.rights ?? [])
							if (!st.full || kept.includes(h.deliveryId)) stamps.set(JSON.stringify(st), st);
				return {
					...c,
					...(only
						? { ...(only.kind ? { kind: only.kind } : {}), ...(only.thread ? { thread: only.thread } : {}) }
						: { kind: "digest" }),
					...(l.name ? { receiver: l.name } : {}),
					...(stamps.size ? { rights: [...stamps.values()] } : {}),
				};
			},
			l.name,
		);
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

	/**
	 * The one serial queue every transport POST goes through, a wake of any receiver or a compaction: each job starts only when the one before it has settled
	 * (resolved, rejected or timed out: the transports have a deadline), so the webhook never has two requests in flight. A job's failure is
	 * its caller's, never the queue's.
	 */
	let queueTail: Promise<unknown> = Promise.resolve();
	function serially<T>(job: () => Promise<T>): Promise<T> {
		const run = queueTail.then(job);
		queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Rows already logged as waiting on their prerequisite, so a long wait is one line. */
	const waitingOn = new Set<string>();
	/** At most this many prerequisites in one attempt: a state that keeps moving under the relay waits for the next pass. */
	const ROUNDS = 3;

	/**
	 * What must be delivered before an attempt of a Steward row that depends on the Steward holding the rights (`needsRights`): asked before
	 * EVERY attempt, retries and restarts included, never only once. Returns the rows delivered ahead of it on this attempt ([] when the durable
	 * record already shows the Steward there now holds the rights in force now), or null when the row must not be sent on this pass: the state
	 * could not be read, queueing failed, or the prerequisite is owed, backing off, failed this time or dead-lettered (the row waits, using no
	 * attempt, until the operator retries it; cancelling a prerequisite makes the relay queue a fresh one, so giving up means cancelling the row).
	 * When the rights cannot be read, a delivered prerequisite carrying the unreadable notice is enough: nothing can show more.
	 */
	async function ahead(l: Lane, row: OutboxRow): Promise<OutboxRow[] | null> {
		const before: OutboxRow[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			let now: Awaited<ReturnType<NonNullable<RelayDeps["rightsNow"]>>>;
			try {
				now = await d.rightsNow!();
			} catch (e) {
				d.log("rights-first-error", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
				return null;
			}
			// The epoch is the database's, read now: from here to the prerequisite's enqueue nothing awaits, so its stamp has this epoch too.
			try {
				now = { ...now, epoch: rightsEpoch(store) };
			} catch (e) {
				d.log("rights-first-error", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
				return null;
			}
			const reason = rightsGap(loadRightsSent(store), now);
			if (!reason) {
				waitingOn.delete(row.deliveryId);
				return before;
			}
			const key = rightsStateKey(now);
			// The prerequisite for this state: the first of `:1`, `:2`, ... that has not ended. One that ended delivered without the record showing
			// it now (a compaction cleared it), or that the operator cancelled, gives way to the next.
			let id = "",
				delivered = false;
			for (let n = 1; ; n++) {
				if (n > 50) {
					d.log("rights-first-error", {
						deliveryId: row.deliveryId,
						error: "50 prerequisites for one state have ended without the record showing it",
					});
					return null;
				}
				id = rightsFirstId(row.deliveryId, key, n);
				const status =
					store.wakes.find(id)?.status ??
					(store.wakes.known(id) ? (store.wakes.isDelivered(id) ? "delivered" : "cancelled") : undefined);
				if (status === "delivered") {
					delivered = true;
					continue;
				}
				if (status !== "cancelled") break;
			}
			if (now.hash === undefined && delivered) return before;
			let first = store.wakes.find(id);
			if (!first) {
				const t = clock();
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
					return null;
				}
				if (!done) {
					d.log("rights-first-skipped", { deliveryId: row.deliveryId, first: id, reason });
					return null;
				}
				crashPoint("rights-first-queued");
				d.log("rights-first", { deliveryId: row.deliveryId, first: id, reason });
				first = store.wakes.find(id);
				if (!first) return null;
			}
			if (first.status !== "pending" || owed.has(first.id) || (notBefore.get(first.id) ?? -Infinity) > clock()) {
				if (!waitingOn.has(row.deliveryId)) {
					waitingOn.add(row.deliveryId);
					d.log("rights-first-waiting", { deliveryId: row.deliveryId, first: id, status: first.status });
				}
				return null;
			}
			const sent = await send(l, first, true);
			if (!sent.length) return null;
			before.push(...sent);
			if (!d.lock.held()) return null;
		}
		return null;
	}

	/**
	 * A prerequisite sent on its own (its row went, was cancelled, or is behind it in the pass) only while it is still for the state there is now:
	 * one for an older state would put older rights after newer ones, so it is cancelled instead (`rights-first-obsolete`). True: send it.
	 */
	async function current(row: OutboxRow): Promise<boolean> {
		if (store.wakes.find(row.deliveryId)?.status !== "pending") return false;
		let now: Awaited<ReturnType<NonNullable<RelayDeps["rightsNow"]>>>;
		try {
			now = { ...(await d.rightsNow!()), epoch: rightsEpoch(store) };
		} catch (e) {
			d.log("rights-first-error", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
			return false;
		}
		if (rightsFirstKey(row.deliveryId) === rightsStateKey(now)) return true;
		if (store.wakes.cancel(row.deliveryId, clock()) === "pending")
			d.log("rights-first-obsolete", { deliveryId: row.deliveryId });
		return false;
	}

	/**
	 * One attempt of one row: counted and committed first, then the POST. The rows delivered: any prerequisite sent ahead of it, then the
	 * row itself. It runs in the serial queue (see `serially`), the prerequisites and the row one after the other in the same job.
	 */
	async function send(l: Lane, row: OutboxRow, prerequisite = false): Promise<OutboxRow[]> {
		if (!d.lock.held()) return [];
		if (row.attempts >= max) {
			deadLetter(l, row, row.attempts);
			return [];
		}
		let before: OutboxRow[] = [];
		if (
			!prerequisite &&
			!l.desk &&
			d.rightsNow &&
			rightsFirstKey(row.deliveryId) &&
			row.kind === "rights" &&
			!(await current(row))
		)
			return [];
		if (!prerequisite && !l.desk && d.rightsNow && needsRights(row.rights)) {
			const went = await ahead(l, row);
			if (went === null) return [];
			before = went;
			if (!d.lock.held()) return before;
		}
		const n = store.tx(() => {
			const n = store.wakes.beginAttempt(row.id, clock());
			crashPoint("attempt-begun");
			return n;
		});
		if (n === undefined) return before;
		crashPoint("attempt-counted");
		let r: WakeResult;
		try {
			r = await l.wake.send(row.deliveryId, withDeliveryId(row.message, row.deliveryId));
		} catch (e) {
			r = { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		const digest = row.members.length !== 1 || row.members[0]!.deliveryId !== row.deliveryId;
		if (r.ok) {
			crashPoint("accepted");
			owed.set(row.id, row);
			l.look.lastPostAt = clock();
			l.failures = 0;
			notBefore.delete(row.id);
			d.log("delivered", {
				deliveryId: row.deliveryId,
				...(r.status !== undefined ? { http: r.status } : {}),
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
			});
			return land(row) ? [...before, row] : before;
		}
		d.log("deliver-error", {
			deliveryId: row.deliveryId,
			attempt: n,
			...(l.name ? { receiver: l.name } : {}),
			...(r.status !== undefined ? { http: r.status } : {}),
			...(r.error ? { error: r.error.slice(0, 200) } : {}),
		});
		if (++l.failures >= 2) raise(l.akey("wake-delivery"), alarms.wakeUnreachable(l.desk, l.failures, max));
		if (n >= max) deadLetter(l, row, n);
		else notBefore.set(row.id, clock() + pause(n));
		return before;
	}

	/** One pass. Returns the delivery ids delivered in it (a digest's members). */
	async function passOnce(): Promise<string[]> {
		if (!d.lock.held()) {
			if (!lockLost) {
				lockLost = true;
				d.log("relay-lock-released");
			}
			return [];
		}
		for (const row of [...owed.values()]) land(row);
		const now = clock();
		const ready = new Set<Lane>();
		for (const l of lanes) {
			if (l.wake.ready()) {
				ready.add(l);
				compose(l, now);
				continue;
			}
			if (
				now - l.notReadyAt >= 60_000 &&
				(store.wakes.held(l.name).length || store.wakes.rows("pending", l.name).length)
			) {
				l.notReadyAt = now;
				d.log("deliver-not-ready", l.name ? { receiver: l.name } : undefined);
				raise(l.akey("wake-not-ready"), alarms.wakeNowhere(l.desk));
			}
		}
		const out: string[] = [];
		// Every receiver's pending rows, oldest first: each receiver's own rows keep their order, and each row goes to its receiver's transport.
		for (const row of store.wakes.rows("pending")) {
			const l = laneOf(row.receiver);
			if (!l) {
				if (!unrouted.has(row.id)) {
					unrouted.add(row.id);
					d.log("deliver-no-receiver", { deliveryId: row.deliveryId, receiver: row.receiver });
				}
				continue;
			}
			if (!ready.has(l) || owed.has(row.id) || (notBefore.get(row.id) ?? -Infinity) > clock()) continue;
			const sent = await serially(() => send(l, row));
			for (const r of sent) out.push(...r.members.map((m) => m.deliveryId));
		}
		return out;
	}

	let chain: Promise<string[]> = Promise.resolve([]);
	let next: Promise<string[]> | undefined;
	/** One pass at a time; a call while one waits to start joins it. */
	function pass(): Promise<string[]> {
		if (next) return next;
		const p = chain
			.then(() => {
				next = undefined;
				return passOnce();
			})
			.catch((e) => {
				d.log("relay-error", { error: String(e).slice(0, 200) });
				return [] as string[];
			});
		next = p;
		chain = p;
		return p;
	}

	const reported = new Set<string>();
	/** A receiver's dead letters raise its `wake-dead-letter` alarm until the operator retries or cancels them. */
	function flagDead(l: Lane) {
		const dead = store.wakes.rows("dead_letter", l.name);
		if (!dead.length) return;
		for (const w of dead)
			if (!reported.has(w.deliveryId)) {
				reported.add(w.deliveryId);
				d.log("deliver-dead-letter-reported", { deliveryId: w.deliveryId, attempts: w.attempts });
			}
		raise(
			l.akey("wake-dead-letter"),
			alarms.wakeDeadLetters(
				l.desk,
				dead.map((w) => w.deliveryId),
				max,
			),
		);
	}

	/** Once a minute: keeps each receiver's busy stretch measured, and raises its stale and dead-letter alarms, and the orphan alarm. */
	function audit() {
		for (const l of lanes) auditLane(l);
		auditOrphans();
	}
	/**
	 * Rows (pending or dead-lettered) and held wakes whose receiver this relay has no transport for: a receiver removed from config while its
	 * wakes were still waiting. They would wait forever, so each such receiver raises its own `<receiver>:wake-unconfigured` alarm, naming it
	 * and the count, on the same repeat policy as every other alarm. They are never dropped and never sent elsewhere: the operator configures
	 * the receiver again (they then go to it) or gives the rows up with `bun src/wakes.ts cancel <id>` (`list` shows each row's receiver).
	 * Held wakes cannot be cancelled: they become a row only once their receiver is configured again.
	 */
	function auditOrphans() {
		const known = new Set(lanes.map((l) => l.name));
		const orphans = new Map<string, { rows: OutboxRow[]; held: number }>();
		const of = (name: string) => orphans.get(name) ?? (orphans.set(name, { rows: [], held: 0 }), orphans.get(name)!);
		for (const r of [...store.wakes.rows("pending"), ...store.wakes.rows("dead_letter")])
			if (r.receiver && !known.has(r.receiver)) of(r.receiver).rows.push(r);
		for (const h of store.wakes.held()) if (h.receiver && !known.has(h.receiver)) of(h.receiver).held++;
		for (const [name, o] of orphans) {
			const n = o.rows.length;
			if (!reported.has(`orphan:${name}:${n}:${o.held}`)) {
				reported.add(`orphan:${name}:${n}:${o.held}`);
				d.log("deliver-receiver-unconfigured", { receiver: name, rows: n, held: o.held });
			}
			raise(
				`${name}:wake-unconfigured`,
				alarms.wakeOrphaned(
					name,
					o.rows.map((r) => r.deliveryId),
					o.held,
				),
			);
		}
	}
	function auditLane(l: Lane) {
		const now = clock();
		try {
			observe(l.look, l.gate(), now, ceiling);
		} catch (e) {
			d.log("gate-error", { error: String(e).slice(0, 200), ...(l.name ? { receiver: l.name } : {}) });
		}
		const waiting = [
			...store.wakes.rows("pending", l.name).map((r) => ({ deliveryId: r.deliveryId, queuedAt: r.createdAt })),
			...store.wakes.held(l.name),
		];
		const old = waiting.filter((w) => now - w.queuedAt > (d.staleAfterMs ?? STALE_AFTER_MS));
		for (const w of old)
			if (!reported.has(`stale:${w.deliveryId}`)) {
				reported.add(`stale:${w.deliveryId}`);
				d.log("deliver-stale", { deliveryId: w.deliveryId, ageMs: now - w.queuedAt });
			}
		if (old.length)
			raise(
				l.akey("wake-stale"),
				alarms.wakesStale(l.desk, old.length, Math.round((d.staleAfterMs ?? STALE_AFTER_MS) / 3600_000)),
			);
		flagDead(l);
	}

	/** Whether the adapter has a compaction target that can take a request now. */
	const compactReady = () => Boolean(d.compact?.ready());
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
	function compact(deliveryId: string): Promise<WakeResult> {
		// Queued behind any wake in flight, and checked when it is its turn: the lock may have been released while it waited.
		return serially(async () => {
			if (!d.lock.held()) throw new Error("the relay no longer holds the one-relay lock: nothing is sent");
			if (!d.compact) throw new Error("this adapter has no compaction target");
			const epoch = invalidateRights(store);
			d.log("rights-invalidated", { reason: "compaction", deliveryId, epoch });
			crashPoint("compact-invalidated");
			return d.compact.send(deliveryId, "");
		});
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		pass,
		audit,
		compact,
		compactReady,
		/** Failed attempts in a row: the Steward's, or a named receiver's. */
		failures: (receiver?: string) => laneOf(receiver)?.failures ?? 0,
		/** Starts the poll. Resolves when the first pass (startup recovery) is done. */
		start(pollMs = relayPollMs()) {
			timer ??= setInterval(() => {
				void pass();
			}, pollMs);
			return pass();
		},
		async stop() {
			clearInterval(timer);
			timer = undefined;
			await chain;
			await queueTail;
		},
	};
}
export type Relay = ReturnType<typeof createRelay>;

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
import { maxAttemptsFromEnv, STALE_AFTER_MS, withDeliveryId, type WakeDraft, type WakeResult, type WakeTransport } from "./deliver.ts";
import { composeWake, HOLD_CEILING_MS, observe, type Gate } from "./hold.ts";
import { isRelayLock, lockCovers, type RelayLock } from "./singleton.ts";
import type { HoldClock, OutboxRow, RightsStamp, Store } from "./store.ts";

/** The pause before a failed row is tried again: one minute, then four, so a webhook back within about five minutes loses nothing. */
export const retryAfterMs = (attempts: number) => Math.min(60_000 * 4 ** (attempts - 1), 15 * 60_000);
/** CHAMBERLAIN_RELAY_POLL_MS if it is a positive number, else one second. */
export const relayPollMs = (env: Record<string, string | undefined> = process.env) => { const n = Number(env.CHAMBERLAIN_RELAY_POLL_MS); return n > 0 ? n : 1000; };

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
	 * Asked just before each attempt of a row that carries rights stamps (a "rights unchanged" pointer, `WakeMeta.rights`), in the serial queue:
	 * does the Steward the pointer was composed for still hold those rights? Undefined means send the row as it is. Otherwise the row is
	 * SUPERSEDED: in one transaction it is cancelled (its ids keep their tombstones, and it is never POSTed again) and the fresh wake returned
	 * here, composed for the current Steward with the full block, is queued in its place and sent at once. Rows stay immutable: a stale pointer
	 * is replaced, never rewritten.
	 */
	supersede?: (row: OutboxRow) => Promise<{ reason: string; wake: WakeDraft } | undefined>;
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
type Lane = { name: string | null; wake: WakeTransport; gate: () => Gate; look: HoldClock; failures: number; notReadyAt: number; desk: boolean; akey: (k: string) => string };

export function createRelay(d: RelayDeps) {
	const { store } = d;
	if (!isRelayLock(d.lock) || !d.lock.held()) throw new Error("createRelay needs the one-relay lock, held: take it first (singleton.ts) and pass the handle it returns");
	// The handle must be the lock on THIS store's database file: a lock held on some other database authorizes nothing here.
	if (!lockCovers(d.lock, store.path)) throw new Error(`createRelay was given a lock that is not on this store's database: the lock handle is for ${d.lock.path}, the store is ${store.path}. Take the lock on the very database file the store opened.`);
	// One relay per lock: a second relay would be a second POST queue beside the first. Every receiver is a lane of this one (`receivers`).
	if (relayed.has(d.lock)) throw new Error("createRelay: a relay already exists on this lock, and there is one relay per store. Send another receiver's wakes through that relay (`receivers`), never a second one.");
	relayed.add(d.lock);
	const clock = () => d.now?.() ?? Date.now();
	/** Alarm keys and titles of a named receiver say whose wakes they are, so the desk's alarm never silences the Steward's. */
	const lane = (name: string | null, wake: WakeTransport, gate: () => Gate): Lane => ({ name, wake, gate, look: {}, failures: 0, notReadyAt: -Infinity, desk: name !== null, akey: (k) => (name ? `${name}:${k}` : k) });
	const steward = lane(null, d.wake, d.gate);
	const lanes: Lane[] = [steward, ...Object.entries(d.receivers ?? {}).map(([name, r]) => lane(name, r.wake, r.gate))];
	const laneOf = (receiver: string | undefined) => lanes.find((l) => l.name === (receiver ?? null));
	const max = d.maxAttempts !== undefined && Number.isInteger(d.maxAttempts) && d.maxAttempts >= 1 ? d.maxAttempts : maxAttemptsFromEnv();
	const pause = d.retryAfterMs ?? retryAfterMs;
	const ceiling = d.ceilingMs ?? HOLD_CEILING_MS;
	/** Rows the transport accepted whose delivered commit has not landed: never POSTed again, the commit is retried every pass. */
	const owed = new Map<number, OutboxRow>();
	/** When a failed row may be tried again. In memory: a restart tries every pending row at once (each try is still counted). */
	const notBefore = new Map<number, number>();
	let lockLost = false;
	/** Rows whose receiver this relay has no transport for, already logged. */
	const unrouted = new Set<number>();

	/** The row's delivered commit. False while it cannot commit (the row stays owed). */
	function land(row: OutboxRow): boolean {
		try {
			if (!store.wakes.finish(row.id, "delivered", clock())) d.log("delivered-after-cancel", { deliveryId: row.deliveryId });
		} catch (e) {
			d.log("delivered-record-failed", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) });
			return false;
		}
		owed.delete(row.id);
		crashPoint("delivered");
		for (const m of row.members) { try { d.onDelivered?.(m.deliveryId); } catch (e) { d.log("on-delivered-error", { deliveryId: m.deliveryId, error: String(e).slice(0, 200) }); } }
		return true;
	}

	function deadLetter(l: Lane, row: OutboxRow, attempts: number) {
		if (store.wakes.finish(row.id, "dead_letter", clock())) d.log("deliver-dead-letter", { deliveryId: row.deliveryId, attempts, ...(l.name ? { receiver: l.name } : {}) });
		notBefore.delete(row.id);
		flagDead(l);
	}

	/** A receiver's held wakes become ONE row when that receiver may take a wake. */
	function compose(l: Lane, now: number) {
		if (!store.wakes.held(l.name).length) return;
		const look = observe(l.look, l.gate(), now, ceiling);
		if (!look.post) return;
		const row = store.wakes.compose(now, (held) => {
			const c = composeWake(held, now);
			const only = held.length === 1 ? held[0]! : undefined;
			// The digest carries every pointer its members carry, so the relay checks each of their stamps before sending it.
			const stamps = new Map<string, RightsStamp>();
			for (const h of held) if (c.members.includes(h.deliveryId)) for (const st of h.rights ?? []) stamps.set(JSON.stringify(st), st);
			return { ...c, ...(only ? { ...(only.kind ? { kind: only.kind } : {}), ...(only.thread ? { thread: only.thread } : {}) } : { kind: "digest" }), ...(l.name ? { receiver: l.name } : {}), ...(stamps.size ? { rights: [...stamps.values()] } : {}) };
		}, l.name);
		if (!row) return;
		crashPoint("composed");
		if (look.forced) l.look.lastForcedAt = now;
		d.log("composed", { deliveryId: row.deliveryId, members: row.members.map((m) => m.deliveryId), folded: row.folded, ...(look.forced ? { forced: "ceiling" } : {}) });
	}

	/**
	 * The one serial queue every transport POST goes through, a wake of any receiver or a compaction: each job starts only when the one before it has settled
	 * (resolved, rejected or timed out: the transports have a deadline), so the webhook never has two requests in flight. A job's failure is
	 * its caller's, never the queue's.
	 */
	let queueTail: Promise<unknown> = Promise.resolve();
	function serially<T>(job: () => Promise<T>): Promise<T> {
		const run = queueTail.then(job);
		queueTail = run.then(() => undefined, () => undefined);
		return run;
	}

	/**
	 * A row whose rights pointer no longer holds for the current Steward (`supersede`): cancelled, and the fresh wake queued in its place, in one
	 * transaction. Returns the replacement row to send now, undefined to send this row as it is, or null when it is no longer pending (the
	 * operator cancelled it meanwhile) or the check failed: then nothing is sent on this pass.
	 */
	async function replaced(row: OutboxRow): Promise<OutboxRow | undefined | null> {
		let verdict: Awaited<ReturnType<NonNullable<RelayDeps["supersede"]>>>;
		try { verdict = await d.supersede!(row); } catch (e) { d.log("supersede-error", { deliveryId: row.deliveryId, error: String(e).slice(0, 200) }); return null; }
		if (!verdict) return undefined;
		const reason = verdict.reason, fresh = verdict.wake;
		const now = clock();
		let done: boolean;
		try {
			done = store.tx(() => {
				if (store.wakes.cancel(row.deliveryId, now) !== "pending") return false;
				// Both or neither: a replacement that cannot be queued rolls the cancel back, and the row waits for the next pass.
				if (!store.wakes.enqueue({ deliveryId: fresh.deliveryId, message: fresh.message, queuedAt: now, ...fresh.meta, ...(row.receiver ? { receiver: row.receiver } : {}) })) throw Error(`the replacement's delivery id ${fresh.deliveryId} is already known`);
				return true;
			});
		} catch (e) { d.log("supersede-error", { deliveryId: row.deliveryId, by: fresh.deliveryId, error: String(e).slice(0, 200) }); return null; }
		notBefore.delete(row.id);
		if (!done) { d.log("supersede-skipped", { deliveryId: row.deliveryId, by: fresh.deliveryId, reason }); return null; }
		d.log("wake-superseded", { deliveryId: row.deliveryId, by: fresh.deliveryId, reason, ...(row.receiver ? { receiver: row.receiver } : {}) });
		return store.wakes.find(fresh.deliveryId) ?? null;
	}

	/** One attempt of one row: counted and committed first, then the POST. The row delivered (a superseded row's replacement), or undefined. It runs in the serial queue (see `serially`). */
	async function send(l: Lane, row: OutboxRow): Promise<OutboxRow | undefined> {
		if (!d.lock.held()) return undefined;
		if (row.attempts >= max) { deadLetter(l, row, row.attempts); return undefined; }
		if (row.rights?.length && d.supersede) {
			const fresh = await replaced(row);
			if (fresh) return send(l, fresh);
			if (fresh === null) return undefined;
		}
		const n = store.tx(() => { const n = store.wakes.beginAttempt(row.id, clock()); crashPoint("attempt-begun"); return n; });
		if (n === undefined) return undefined;
		crashPoint("attempt-counted");
		let r: WakeResult;
		try { r = await l.wake.send(row.deliveryId, withDeliveryId(row.message, row.deliveryId)); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
		const digest = row.members.length !== 1 || row.members[0]!.deliveryId !== row.deliveryId;
		if (r.ok) {
			crashPoint("accepted");
			owed.set(row.id, row);
			l.look.lastPostAt = clock();
			l.failures = 0;
			notBefore.delete(row.id);
			d.log("delivered", { deliveryId: row.deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: n, queuedAt: row.createdAt, ...(row.kind ? { kind: row.kind } : {}), ...(row.thread ? { thread: row.thread } : {}), ...(l.name ? { receiver: l.name } : {}), ...(digest ? { members: row.members.map((m) => ({ deliveryId: m.deliveryId, queuedAt: m.queuedAt, ...(m.kind ? { kind: m.kind } : {}), ...(m.thread ? { thread: m.thread } : {}) })) } : {}) });
			return land(row) ? row : undefined;
		}
		d.log("deliver-error", { deliveryId: row.deliveryId, attempt: n, ...(l.name ? { receiver: l.name } : {}), ...(r.status !== undefined ? { http: r.status } : {}), ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
		if (++l.failures >= 2) d.alarm(l.akey("wake-delivery"), l.desk ? "chamberlain cannot reach the Alert Desk thread" : "chamberlain cannot reach its wake thread", `${l.failures} wake attempts in a row failed. The ${l.desk ? "Alert Desk" : "Steward"} thread may be deleted, the webhook revoked, or the server down or asleep. Each wake is tried ${max} times, then kept as a dead letter.`);
		if (n >= max) deadLetter(l, row, n);
		else notBefore.set(row.id, clock() + pause(n));
		return undefined;
	}

	/** One pass. Returns the delivery ids delivered in it (a digest's members). */
	async function passOnce(): Promise<string[]> {
		if (!d.lock.held()) { if (!lockLost) { lockLost = true; d.log("relay-lock-released"); } return []; }
		for (const row of [...owed.values()]) land(row);
		const now = clock();
		const ready = new Set<Lane>();
		for (const l of lanes) {
			if (l.wake.ready()) { ready.add(l); compose(l, now); continue; }
			if (now - l.notReadyAt >= 60_000 && (store.wakes.held(l.name).length || store.wakes.rows("pending", l.name).length)) {
				l.notReadyAt = now;
				d.log("deliver-not-ready", l.name ? { receiver: l.name } : undefined);
				d.alarm(l.akey("wake-not-ready"), "chamberlain has nowhere to send wakes", `Wakes are waiting but no ${l.desk ? "desk wake URL" : "wake URL"} is configured (or readable), so nothing can reach ${l.desk ? "the Alert Desk" : "the Steward"}. They are kept, no attempt is used, and they go as soon as there is one.`);
			}
		}
		const out: string[] = [];
		// Every receiver's pending rows, oldest first: each receiver's own rows keep their order, and each row goes to its receiver's transport.
		for (const row of store.wakes.rows("pending")) {
			const l = laneOf(row.receiver);
			if (!l) {
				if (!unrouted.has(row.id)) { unrouted.add(row.id); d.log("deliver-no-receiver", { deliveryId: row.deliveryId, receiver: row.receiver }); }
				continue;
			}
			if (!ready.has(l) || owed.has(row.id) || (notBefore.get(row.id) ?? -Infinity) > clock()) continue;
			const sent = await serially(() => send(l, row));
			if (sent) out.push(...sent.members.map((m) => m.deliveryId));
		}
		return out;
	}

	let chain: Promise<string[]> = Promise.resolve([]);
	let next: Promise<string[]> | undefined;
	/** One pass at a time; a call while one waits to start joins it. */
	function pass(): Promise<string[]> {
		if (next) return next;
		const p = chain.then(() => { next = undefined; return passOnce(); }).catch((e) => { d.log("relay-error", { error: String(e).slice(0, 200) }); return [] as string[]; });
		next = p;
		chain = p;
		return p;
	}

	const reported = new Set<string>();
	/** A receiver's dead letters raise its `wake-dead-letter` alarm until the operator retries or cancels them. */
	function flagDead(l: Lane) {
		const dead = store.wakes.rows("dead_letter", l.name);
		if (!dead.length) return;
		for (const w of dead) if (!reported.has(w.deliveryId)) { reported.add(w.deliveryId); d.log("deliver-dead-letter-reported", { deliveryId: w.deliveryId, attempts: w.attempts }); }
		d.alarm(l.akey("wake-dead-letter"), l.desk ? "chamberlain stopped sending Alert Desk wakes that were not delivered" : "chamberlain stopped sending wakes that were not delivered", `${dead.length} wake${dead.length === 1 ? " was" : "s were"} attempted ${max} times without being delivered and ${dead.length === 1 ? "is" : "are"} not sent again: ${dead.slice(0, 5).map((w) => w.deliveryId).join(", ")}${dead.length > 5 ? ", ..." : ""}. The Steward may or may not have received them. They are kept. In the chamberlain checkout, "bun src/wakes.ts list" shows them, "bun src/wakes.ts retry <id>" sends one again (${max} more attempts at most) and "bun src/wakes.ts cancel <id>" gives it up.`);
	}

	/** Once a minute: keeps each receiver's busy stretch measured, and raises its stale and dead-letter alarms. */
	function audit() {
		for (const l of lanes) auditLane(l);
	}
	function auditLane(l: Lane) {
		const now = clock();
		try { observe(l.look, l.gate(), now, ceiling); } catch (e) { d.log("gate-error", { error: String(e).slice(0, 200), ...(l.name ? { receiver: l.name } : {}) }); }
		const waiting = [...store.wakes.rows("pending", l.name).map((r) => ({ deliveryId: r.deliveryId, queuedAt: r.createdAt })), ...store.wakes.held(l.name)];
		const old = waiting.filter((w) => now - w.queuedAt > (d.staleAfterMs ?? STALE_AFTER_MS));
		for (const w of old) if (!reported.has(`stale:${w.deliveryId}`)) { reported.add(`stale:${w.deliveryId}`); d.log("deliver-stale", { deliveryId: w.deliveryId, ageMs: now - w.queuedAt }); }
		if (old.length) d.alarm(l.akey("wake-stale"), "chamberlain has wakes it could not deliver", `${old.length} wake${old.length === 1 ? " has" : "s have"} waited more than ${Math.round((d.staleAfterMs ?? STALE_AFTER_MS) / 3600_000)} hours without reaching ${l.desk ? "the Alert Desk" : "the Steward"}. They are kept; none is dropped. Is the daemon running, and is the wake URL right?`);
		flagDead(l);
	}

	/** Whether the adapter has a compaction target that can take a request now. */
	const compactReady = () => Boolean(d.compact?.ready());
	/**
	 * One compaction request to the Steward's compaction task: a single attempt, no row (the task's prompt is /compact, so it takes no message),
	 * and it throws when it cannot be sent. It lives here so that the relay is the only code that calls a transport, and it waits its turn in
	 * the same serial queue as the wakes (a compaction is not a row, so it is not retried, but it is never beside another POST).
	 */
	function compact(deliveryId: string): Promise<WakeResult> {
		// Queued behind any wake in flight, and checked when it is its turn: the lock may have been released while it waited.
		return serially(async () => {
			if (!d.lock.held()) throw new Error("the relay no longer holds the one-relay lock: nothing is sent");
			if (!d.compact) throw new Error("this adapter has no compaction target");
			return d.compact.send(deliveryId, "");
		});
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		pass, audit, compact, compactReady,
		/** Failed attempts in a row: the Steward's, or a named receiver's. */
		failures: (receiver?: string) => laneOf(receiver)?.failures ?? 0,
		/** Starts the poll. Resolves when the first pass (startup recovery) is done. */
		start(pollMs = relayPollMs()) { timer ??= setInterval(() => { void pass(); }, pollMs); return pass(); },
		async stop() { clearInterval(timer); timer = undefined; await chain; await queueTail; },
	};
}
export type Relay = ReturnType<typeof createRelay>;

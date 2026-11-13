/**
 * The message relay of the transactional outbox: the ONLY code that calls a wake transport (`wake`, and `compact` through `relay.compact`),
 * and it runs in the daemon alone (one daemon per state directory, enforced by singleton.ts). It cannot be built without the held lock:
 * `createRelay` requires the handle `holdRelayLock` returned and refuses anything else, and refuses a handle that is not the lock on the
 * database file its store opened, in the directory the lock is on (the handle records both devices and inodes; `lockCovers`), and it sends
 * nothing once that lock is released.
 * Producers (the engine, the sweep, the page, `synthetic-wake.ts`) only insert rows (deliver.ts); `wakes.ts` only changes a row's status;
 * no other process talks to the webhook. src/architecture.test.ts fails if another module calls a transport or POSTs.
 *
 * Each pass, a short poll (CHAMBERLAIN_RELAY_POLL_MS, default 1 s) or a nudge from a producer in this process:
 *   1. Held wakes are composed into ONE row when the Steward is idle or has been busy for the ceiling (hold.ts): one transaction freezes the
 *      row's delivery id, text and members, and binds each held item to it for good.
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
import { maxAttemptsFromEnv, STALE_AFTER_MS, withDeliveryId, type WakeResult, type WakeTransport } from "./deliver.ts";
import { composeWake, HOLD_CEILING_MS, observe, type Gate } from "./hold.ts";
import { isRelayLock, lockCovers, type RelayLock } from "./singleton.ts";
import type { HoldClock, OutboxRow, Store } from "./store.ts";

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
	/** The way a wake reaches the Steward (`Adapter.wake`). */
	wake: WakeTransport;
	/** The way a compaction reaches the Steward's compaction task (`Adapter.compact`), if the adapter has one. Sent only through `relay.compact`. */
	compact?: WakeTransport;
	/** The Steward's thread, read fresh: held wakes are composed when it is idle (or at the ceiling). */
	gate: () => Gate;
	log: (event: string, data?: Record<string, unknown>) => void;
	alarm: (key: string, title: string, summary: string) => void;
	/** Runs for each delivery id a row carries, right after the row is committed delivered. Idempotent: recovery may run it again. */
	onDelivered?: (deliveryId: string) => void;
	/** Attempts per row before it is dead-lettered (default CHAMBERLAIN_MAX_ATTEMPTS, else 3). */
	maxAttempts?: number;
	retryAfterMs?: (attempts: number) => number;
	ceilingMs?: number;
	staleAfterMs?: number;
	now?: () => number;
};

export function createRelay(d: RelayDeps) {
	const { store } = d;
	if (!isRelayLock(d.lock) || !d.lock.held()) throw new Error("createRelay needs the one-relay lock, held: take it first (singleton.ts) and pass the handle it returns");
	// The handle must be the lock on THIS store's database file: a lock held on some other database authorizes nothing here.
	if (!lockCovers(d.lock, store.path)) throw new Error(`createRelay was given a lock that is not on this store's database: the lock handle is for ${d.lock.path}, the store is ${store.path}. Take the lock on the very database file the store opened.`);
	const clock = () => d.now?.() ?? Date.now();
	const max = d.maxAttempts !== undefined && Number.isInteger(d.maxAttempts) && d.maxAttempts >= 1 ? d.maxAttempts : maxAttemptsFromEnv();
	const pause = d.retryAfterMs ?? retryAfterMs;
	const ceiling = d.ceilingMs ?? HOLD_CEILING_MS;
	/** The look at the Steward. In memory: there is one relay, and a restart only restarts the busy stretch. */
	const gate: HoldClock = {};
	/** Rows the transport accepted whose delivered commit has not landed: never POSTed again, the commit is retried every pass. */
	const owed = new Map<number, OutboxRow>();
	/** When a failed row may be tried again. In memory: a restart tries every pending row at once (each try is still counted). */
	const notBefore = new Map<number, number>();
	let failures = 0;
	let lockLost = false;
	let notReadyAt = -Infinity;

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

	function deadLetter(row: OutboxRow, attempts: number) {
		if (store.wakes.finish(row.id, "dead_letter", clock())) d.log("deliver-dead-letter", { deliveryId: row.deliveryId, attempts });
		notBefore.delete(row.id);
		flagDead();
	}

	/** Held wakes become ONE row when the Steward may take a wake. */
	function compose(now: number) {
		if (!store.wakes.held().length) return;
		const look = observe(gate, d.gate(), now, ceiling);
		if (!look.post) return;
		const row = store.wakes.compose(now, (held) => {
			const c = composeWake(held, now);
			const only = held.length === 1 ? held[0]! : undefined;
			return { ...c, ...(only ? { ...(only.kind ? { kind: only.kind } : {}), ...(only.thread ? { thread: only.thread } : {}) } : { kind: "digest" }) };
		});
		if (!row) return;
		crashPoint("composed");
		if (look.forced) gate.lastForcedAt = now;
		d.log("composed", { deliveryId: row.deliveryId, members: row.members.map((m) => m.deliveryId), folded: row.folded, ...(look.forced ? { forced: "ceiling" } : {}) });
	}

	/**
	 * The one serial queue every transport POST goes through, a wake or a compaction: each job starts only when the one before it has settled
	 * (resolved, rejected or timed out: the transports have a deadline), so the webhook never has two requests in flight. A job's failure is
	 * its caller's, never the queue's.
	 */
	let queueTail: Promise<unknown> = Promise.resolve();
	function serially<T>(job: () => Promise<T>): Promise<T> {
		const run = queueTail.then(job);
		queueTail = run.then(() => undefined, () => undefined);
		return run;
	}

	/** One attempt of one row: counted and committed first, then the POST. True when it is delivered. It runs in the serial queue (see `serially`). */
	async function send(row: OutboxRow): Promise<boolean> {
		if (!d.lock.held()) return false;
		if (row.attempts >= max) { deadLetter(row, row.attempts); return false; }
		const n = store.tx(() => { const n = store.wakes.beginAttempt(row.id, clock()); crashPoint("attempt-begun"); return n; });
		if (n === undefined) return false;
		crashPoint("attempt-counted");
		let r: WakeResult;
		try { r = await d.wake.send(row.deliveryId, withDeliveryId(row.message, row.deliveryId)); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
		const digest = row.members.length !== 1 || row.members[0]!.deliveryId !== row.deliveryId;
		if (r.ok) {
			crashPoint("accepted");
			owed.set(row.id, row);
			gate.lastPostAt = clock();
			failures = 0;
			notBefore.delete(row.id);
			d.log("delivered", { deliveryId: row.deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: n, queuedAt: row.createdAt, ...(row.kind ? { kind: row.kind } : {}), ...(row.thread ? { thread: row.thread } : {}), ...(digest ? { members: row.members.map((m) => ({ deliveryId: m.deliveryId, queuedAt: m.queuedAt, ...(m.kind ? { kind: m.kind } : {}), ...(m.thread ? { thread: m.thread } : {}) })) } : {}) });
			return land(row);
		}
		d.log("deliver-error", { deliveryId: row.deliveryId, attempt: n, ...(r.status !== undefined ? { http: r.status } : {}), ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
		if (++failures >= 2) d.alarm("wake-delivery", "chamberlain cannot reach its wake thread", `${failures} wake attempts in a row failed. The Steward thread may be deleted, the webhook revoked, or the server down or asleep. Each wake is tried ${max} times, then kept as a dead letter.`);
		if (n >= max) deadLetter(row, n);
		else notBefore.set(row.id, clock() + pause(n));
		return false;
	}

	/** One pass. Returns the delivery ids delivered in it (a digest's members). */
	async function passOnce(): Promise<string[]> {
		if (!d.lock.held()) { if (!lockLost) { lockLost = true; d.log("relay-lock-released"); } return []; }
		for (const row of [...owed.values()]) land(row);
		const now = clock();
		if (!d.wake.ready()) {
			if (now - notReadyAt >= 60_000 && (store.wakes.held().length || store.wakes.rows().length)) {
				notReadyAt = now;
				d.log("deliver-not-ready");
				d.alarm("wake-not-ready", "chamberlain has nowhere to send wakes", "Wakes are waiting but no wake URL is configured (or readable), so nothing can reach the Steward. They are kept, no attempt is used, and they go as soon as there is one.");
			}
			return [];
		}
		compose(now);
		const out: string[] = [];
		for (const row of store.wakes.rows()) {
			if (owed.has(row.id) || (notBefore.get(row.id) ?? -Infinity) > clock()) continue;
			if (await serially(() => send(row))) out.push(...row.members.map((m) => m.deliveryId));
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
	/** Dead letters raise the `wake-dead-letter` alarm until the operator retries or cancels them. */
	function flagDead() {
		const dead = store.wakes.rows("dead_letter");
		if (!dead.length) return;
		for (const w of dead) if (!reported.has(w.deliveryId)) { reported.add(w.deliveryId); d.log("deliver-dead-letter-reported", { deliveryId: w.deliveryId, attempts: w.attempts }); }
		d.alarm("wake-dead-letter", "chamberlain stopped sending wakes that were not delivered", `${dead.length} wake${dead.length === 1 ? " was" : "s were"} attempted ${max} times without being delivered and ${dead.length === 1 ? "is" : "are"} not sent again: ${dead.slice(0, 5).map((w) => w.deliveryId).join(", ")}${dead.length > 5 ? ", ..." : ""}. The Steward may or may not have received them. They are kept. In the chamberlain checkout, "bun src/wakes.ts list" shows them, "bun src/wakes.ts retry <id>" sends one again (${max} more attempts at most) and "bun src/wakes.ts cancel <id>" gives it up.`);
	}

	/** Once a minute: keeps the Steward's busy stretch measured, and raises the stale and dead-letter alarms. */
	function audit() {
		const now = clock();
		try { observe(gate, d.gate(), now, ceiling); } catch (e) { d.log("gate-error", { error: String(e).slice(0, 200) }); }
		const waiting = [...store.wakes.rows().map((r) => ({ deliveryId: r.deliveryId, queuedAt: r.createdAt })), ...store.wakes.held()];
		const old = waiting.filter((w) => now - w.queuedAt > (d.staleAfterMs ?? STALE_AFTER_MS));
		for (const w of old) if (!reported.has(`stale:${w.deliveryId}`)) { reported.add(`stale:${w.deliveryId}`); d.log("deliver-stale", { deliveryId: w.deliveryId, ageMs: now - w.queuedAt }); }
		if (old.length) d.alarm("wake-stale", "chamberlain has wakes it could not deliver", `${old.length} wake${old.length === 1 ? " has" : "s have"} waited more than ${Math.round((d.staleAfterMs ?? STALE_AFTER_MS) / 3600_000)} hours without reaching the Steward. They are kept; none is dropped. Is the daemon running, and is the wake URL right?`);
		flagDead();
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
		pass, audit, compact, compactReady, failures: () => failures,
		/** Starts the poll. Resolves when the first pass (startup recovery) is done. */
		start(pollMs = relayPollMs()) { timer ??= setInterval(() => { void pass(); }, pollMs); return pass(); },
		async stop() { clearInterval(timer); timer = undefined; await chain; await queueTail; },
	};
}
export type Relay = ReturnType<typeof createRelay>;

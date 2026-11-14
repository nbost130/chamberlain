/** What the relay runs on: its dependencies and one lane of the outbox, and the context every step is given. */
import type { WakeTransport } from "./deliver.ts";
import type { Gate } from "./hold.ts";
import type { AlarmText } from "./messages.ts";
import type { RightsState } from "./rights-sent.ts";
import type { RelayLock } from "./singleton.ts";
import type { Store } from "./store.ts";
import type { HoldClock, OutboxRow, RightsStamp } from "./store-wakes.ts";

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
export const relayed = new WeakSet<RelayLock>();

/** One receiver the relay sends for: its rows and held wakes (`name`, `null` for the Steward's), its transport and gate, and its own counters. */
export type Lane = {
	name: string | null;
	wake: WakeTransport;
	gate: () => Gate;
	look: HoldClock;
	failures: number;
	notReadyAt: number;
	desk: boolean;
	akey: (k: string) => string;
};

/** The Steward and the rights in force now, as `rightsNow` answers them, with the epoch read from the database. */
export type RightsNow = Awaited<ReturnType<NonNullable<RelayDeps["rightsNow"]>>>;

/** What one relay is made of: its deps, its lanes, and the state every pass shares. */
export type Ctx = {
	d: RelayDeps;
	store: Store;
	lanes: Lane[];
	max: number;
	pause: (attempts: number) => number;
	ceiling: number;
	clock: () => number;
	/** Rows the transport accepted whose delivered commit has not landed: never POSTed again, the commit is retried every pass. */
	owed: Map<number, OutboxRow>;
	/** When a failed row may be tried again. In memory: a restart tries every pending row at once (each try is still counted). */
	notBefore: Map<number, number>;
	/** Rows whose receiver this relay has no transport for, already logged. */
	unrouted: Set<number>;
	/** Rows already logged as waiting on their prerequisite, so a long wait is one line. */
	waitingOn: Set<string>;
	/** Alerts and notices already raised or logged once, by key. */
	reported: Set<string>;
	run: {
		lockLost: boolean;
		/** The serial queue's tail: each POST job starts when the one before has settled. */
		queueTail: Promise<unknown>;
		chain: Promise<string[]>;
		next: Promise<string[]> | undefined;
		timer: ReturnType<typeof setInterval> | undefined;
	};
};

/** At most this many prerequisites in one attempt: a state that keeps moving under the relay waits for the next pass. */
export const ROUNDS = 3;

/** Raises an alarm whose words are in messages.ts. */
export const raise = (r: Ctx, key: string, a: AlarmText) => r.d.alarm(key, a.title, a.summary);

/** Alarm keys and titles of a named receiver say whose wakes they are, so the desk's alarm never silences the Steward's. */
export const makeLane = (name: string | null, wake: WakeTransport, gate: () => Gate): Lane => ({
	name,
	wake,
	gate,
	look: {},
	failures: 0,
	notReadyAt: -Infinity,
	desk: name !== null,
	akey: (k) => (name ? `${name}:${k}` : k),
});
export const laneOf = (r: Ctx, receiver: string | undefined) => r.lanes.find((l) => l.name === (receiver ?? null));

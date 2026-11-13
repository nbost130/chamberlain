/**
 * The producer side of the transactional outbox. The daemon's engine, the sweep, the page and every other producer hand a wake in here,
 * and it becomes a row in the SAME transaction as whatever made it necessary (the notification decision, the sweep's findings, the
 * page's claim and answer). Nothing here sends: only the relay (relay.ts), which runs in the daemon alone, POSTs wakes.
 *
 * A wake that can wait (HOLDABLE_KINDS in hold.ts: a turn end, the sweep) is held instead, and the relay composes what is held into one
 * row when the Steward is idle. Every other wake is a pending row at once.
 */
import { crashPoint } from "./crash.ts";
import { holdable } from "./hold.ts";
import type { Store, WakeMeta } from "./store.ts";

/**
 * How one wake reaches the Steward. The adapter owns the transport (a webhook, a socket call); the relay owns everything around it.
 * `ok: true` means the receiver accepted it. Anything else, `ok: false` or a throw, is an attempt that did not deliver: it is counted all
 * the same (a timeout may well have reached the receiver), and the row is tried again after a pause until its attempts run out.
 */
export type WakeResult = { ok: boolean; /** The transport's own status, such as an HTTP code. Logged, never interpreted. */ status?: number; error?: string };
export type WakeTransport = {
	/** Is there a place to send to right now? Read fresh on every call. False means nothing is attempted: rows wait (the `wake-not-ready` alarm says why) and no attempt is used. */
	ready: () => boolean;
	/** One attempt, with its own deadline. */
	send: (deliveryId: string, message: string) => Promise<WakeResult>;
};
/** A wake ready to enter the outbox: the text, its one delivery id and what it is about. */
export type WakeDraft = { message: string; deliveryId: string; meta?: WakeMeta };

/** How many attempts one row gets before it is dead-lettered (CHAMBERLAIN_MAX_ATTEMPTS overrides it). */
export const MAX_ATTEMPTS = 3;
/** CHAMBERLAIN_MAX_ATTEMPTS if it is a positive whole number, else the default. */
export function maxAttemptsFromEnv(env: Record<string, string | undefined> = process.env): number {
	const n = Number(env.CHAMBERLAIN_MAX_ATTEMPTS);
	return Number.isInteger(n) && n >= 1 ? n : MAX_ATTEMPTS;
}
/** A wake still undelivered after this long raises the `wake-stale` alarm. An alarm, never a deadline: only delivery or a cancel ends a row. */
export const STALE_AFTER_MS = 24 * 3600_000;
/** A delivered or cancelled row is kept this long after it finished (maintain.ts prunes it), unless an unresolved claim still names it. */
export const DELIVERED_KEEP_MS = 30 * 24 * 3600_000;

/**
 * The wake as the transport sends it: its text, and as its last line the delivery id the webhook also receives. The webhook cannot
 * de-duplicate, so the Steward has to: a wake whose delivery id it has already handled is a repeat. The id is frozen with the row, so every
 * POST of it reads the same.
 */
export const DELIVERY_ID_LINE = (deliveryId: string) => `delivery id: ${deliveryId} (the same id again is a repeat: do not act on it twice)`;
export const withDeliveryId = (message: string, deliveryId: string): string => (message.includes(DELIVERY_ID_LINE(deliveryId)) ? message : `${message}\n${DELIVERY_ID_LINE(deliveryId)}`);

/** What `commit` did: nothing to send, written (a pending row or a held item), already known (any row or held item under this id), or a dry run. */
export type Committed = "none" | "queued" | "known" | "dry";

export type OutboxDeps = {
	store: Store;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Records the decision and logs the wake, and writes no row. */
	dry?: boolean;
	now?: () => number;
	/** Runs after a row is written, so a relay in the same process can look at once. */
	queued?: () => void;
};

export function createOutbox(d: OutboxDeps) {
	const { store } = d;
	/**
	 * The one way a wake enters the outbox. `decide` runs inside the transaction that writes the wake's row: it records whatever made the
	 * wake necessary and returns the wake, or nothing. Both commit together or neither does, so a notification is never recorded as sent
	 * without its wake. An id that is already known (pending, held, delivered, dead-lettered or cancelled) writes nothing more.
	 */
	function commit(decide: () => WakeDraft | undefined): Committed {
		const out = store.tx((): { kind: Committed; wake?: WakeDraft } => {
			const wake = decide();
			if (!wake) return { kind: "none" };
			// A kill here leaves neither the decision nor the wake: they are one transaction.
			crashPoint("notified");
			if (d.dry) return { kind: "dry", wake };
			const row = { deliveryId: wake.deliveryId, message: wake.message, queuedAt: d.now?.() ?? Date.now(), ...wake.meta };
			return { kind: (holdable(wake.meta) ? store.wakes.hold(row) : store.wakes.enqueue(row)) ? "queued" : "known", wake };
		});
		if (out.kind === "none") return "none";
		const { deliveryId, message, meta } = out.wake!;
		if (out.kind === "dry") d.log("dry", { deliveryId, message });
		else if (out.kind === "known") d.log("deliver-already-queued", { deliveryId });
		else {
			crashPoint("enqueued");
			d.log(holdable(meta) ? "deliver-held" : "deliver-queued", { deliveryId });
			d.queued?.();
		}
		return out.kind;
	}
	/** A wake with nothing else to record. `alongside` returning false means the decision was already taken elsewhere: nothing is written. */
	const deliver = (message: string, deliveryId: string, meta?: WakeMeta, alongside?: () => boolean | void): Committed =>
		commit(() => (alongside?.() === false ? undefined : { message, deliveryId, ...(meta ? { meta } : {}) }));
	return { commit, deliver };
}
export type Outbox = ReturnType<typeof createOutbox>;

/**
 * Housekeeping on the database, using only the Store interface: forget what has outlived its use. Run at start by the
 * daemon and the page, and once a day by the daemon.
 *
 * Retention prunes ONLY terminal rows: a delivered or cancelled outbox row, a resolved item, an old event. It never touches a pending
 * or dead-lettered row, a held wake, an unresolved claim or a question still open: undelivered work stays until it is delivered or
 * explicitly cancelled. (The database refuses to delete a pending or dead-lettered row: migration 6's trigger.)
 *
 *   - Delivered and cancelled outbox rows finished more than 30 days ago, with their member bindings, unless an unresolved claim still
 *     names one of their delivery ids (the row is what stops that wake going out again).
 *   - Wake and alarm items not seen for 30 days are resolved, and resolved items older than that are deleted. The queue's
 *     own items are history and stay.
 *   - Events older than 90 days.
 *   - Confirmation challenges that expired or were consumed more than a day ago.
 */
import { NOTIFICATION_LOG } from "./notification.ts";
import { DELIVERED_KEEP_MS } from "./deliver.ts";
import type { Store } from "./store.ts";

export const ITEM_KEEP_MS = 30 * 24 * 3600_000;
export const EVENT_KEEP_MS = 90 * 24 * 3600_000;
/** An expired or consumed confirmation challenge is terminal; it is kept a day, so a replay still reads as "used" rather than "unknown". */
export const CHALLENGE_KEEP_MS = 24 * 3600_000;
/** Item sources whose rows only record that something was done or raised; they age out. */
export const EPHEMERAL_SOURCES = [NOTIFICATION_LOG, "alarm"] as const;

export type Maintained = { delivered: number; resolved: number; items: number; events: number; challenges: number };

export function maintain(store: Store, now = Date.now()): Maintained {
	return store.tx(() => {
		let resolved = 0;
		for (const source of EPHEMERAL_SOURCES) {
			for (const i of store.items.list({ source, status: ["triggered", "acknowledged"] })) {
				if (now - i.lastSeen > ITEM_KEEP_MS) { store.items.resolve(source, i.dedupKey, now); resolved++; }
			}
		}
		return {
			delivered: store.wakes.prune(now - DELIVERED_KEEP_MS),
			resolved,
			items: store.items.prune(now - ITEM_KEEP_MS),
			events: store.events.prune(new Date(now - EVENT_KEEP_MS).toISOString()),
			challenges: store.challenges.prune(now - CHALLENGE_KEEP_MS),
		};
	});
}

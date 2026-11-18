/** The held wake status (migration 20): what the daemon learned about a held wake after it was held. Append-only. */
import type { Db } from "./sqlite-db.ts";

/**
 * Marks the held turn-end reports about a thread, held before `at`, superseded: the principal settled or archived the thread, so they
 * need nothing more. Appends one status row each (a row already marked keeps its first status). The ids marked.
 */
export function supersedeHeld(c: Db, thread: string, at: number, why: string): string[] {
	return c.tx(() => {
		const ids = c
			.all(
				`SELECT delivery_id FROM held_wakes h WHERE h.thread = ? AND h.kind = 'turn_ended' AND h.queued_at < ?
				 AND NOT EXISTS (SELECT 1 FROM held_wake_status s WHERE s.delivery_id = h.delivery_id AND s.status = 'superseded')`,
				thread,
				at,
			)
			.map((r) => r.delivery_id as string);
		for (const id of ids)
			c.run("INSERT INTO held_wake_status (delivery_id, status, at, why) VALUES (?, 'superseded', ?, ?)", id, at, why);
		return ids;
	});
}

/**
 * The held items marked superseded, with when and why: only items still held. Driven from held_wakes (CROSS JOIN fixes the order), which
 * holds a handful of rows, so the relay's every pass costs nothing however many marks have been written.
 */
export const supersededHeld = (c: Db): { deliveryId: string; at: number; why: string }[] =>
	c
		.all(
			`SELECT s.delivery_id, s.at, s.why FROM held_wakes h CROSS JOIN held_wake_status s
			 ON s.delivery_id = h.delivery_id AND s.status = 'superseded' ORDER BY h.seq`,
		)
		.map((r) => ({ deliveryId: r.delivery_id as string, at: r.at as number, why: r.why as string }));

/** Deletes the marks of wakes that are no longer held (given up or composed): a mark has no use after that. The trigger refuses a held one. */
export function forgetStatus(c: Db, ids: readonly string[]): void {
	for (const id of ids) c.run("DELETE FROM held_wake_status WHERE delivery_id = ?", id);
}

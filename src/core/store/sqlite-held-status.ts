/** The held wake status (migration 20): what the daemon learned about a held wake after it was held. Append-only. */
import type { Db } from "./sqlite-db.ts";

/**
 * Marks the held turn-end reports about a thread, held before `at`, superseded: the thread started a new turn or was settled or
 * archived, so what they report is stale. Appends one status row each (a row already marked keeps its first status). The ids marked.
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

/** The held items marked superseded, with when and why: only items still held. */
export const supersededHeld = (c: Db): { deliveryId: string; at: number; why: string }[] =>
	c
		.all(
			`SELECT s.delivery_id, s.at, s.why FROM held_wake_status s JOIN held_wakes h ON h.delivery_id = s.delivery_id
			 WHERE s.status = 'superseded' ORDER BY h.seq`,
		)
		.map((r) => ({ deliveryId: r.delivery_id as string, at: r.at as number, why: r.why as string }));

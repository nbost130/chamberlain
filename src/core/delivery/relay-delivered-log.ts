import type { OutboxRow } from "../store/store-wakes.ts";
import type { WakeResult } from "./deliver.ts";
import type { Lane } from "./relay-ctx.ts";

/** Pure: what the `delivered` log line says about a row: its attempt, kind, thread and receiver, and each member of a digest. */
export function deliveredLog(l: Lane, row: OutboxRow, n: number, res: WakeResult): Record<string, unknown> {
	const [only] = row.members;
	const digest = row.members.length !== 1 || only?.deliveryId !== row.deliveryId;
	return {
		deliveryId: row.deliveryId,
		...(res.status !== undefined ? { http: res.status } : {}),
		attempt: n,
		// A lone held wake keeps the time it was held, not the time it was composed, so its wait counts in queue-waits.
		queuedAt: digest ? row.createdAt : (only?.queuedAt ?? row.createdAt),
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
	};
}

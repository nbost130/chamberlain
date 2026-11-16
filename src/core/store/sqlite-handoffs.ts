/** SQL accessors for queued-run handoffs (migration 17 / issue #76). */
import type { HandoffDisposition, HandoffRecord } from "../steward/handoff.ts";
import type { Db, Row } from "./sqlite-db.ts";
import type { HandoffStore, PersistedHandoff } from "./store-handoffs.ts";

const toRow = (r: Row): PersistedHandoff => ({
	server: r.server as string,
	threadId: r.thread_id as string,
	runId: r.run_id as string,
	successorId: r.successor_id as string,
	disposition: r.disposition as HandoffDisposition,
	observedAt: r.observed_at as number,
	updatedAt: r.updated_at as number,
});

const UPSERT = `INSERT INTO run_handoffs (server, thread_id, run_id, successor_id, disposition, observed_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (server, thread_id, run_id) DO UPDATE SET
		successor_id = excluded.successor_id,
		disposition = excluded.disposition,
		updated_at = excluded.updated_at`;

export const makeHandoffs = (c: Db): HandoffStore => ({
	put(server, record, now = Date.now()) {
		c.run(UPSERT, server, record.threadId, record.runId, record.successorId, record.disposition, now, now);
	},
	get(server, threadId, runId) {
		const r = c.one(
			"SELECT * FROM run_handoffs WHERE server = ? AND thread_id = ? AND run_id = ?",
			server,
			threadId,
			runId,
		);
		return r ? toRow(r) : undefined;
	},
	listPending(server) {
		return c.all("SELECT * FROM run_handoffs WHERE server = ? AND disposition = ?", server, "pending").map(toRow);
	},
	listAllPending() {
		return c.all("SELECT * FROM run_handoffs WHERE disposition = ?", "pending").map(toRow);
	},
	listOpen(server) {
		return c.all("SELECT * FROM run_handoffs WHERE server = ? AND disposition != ?", server, "confirmed").map(toRow);
	},
	clearTerminal(server, threadId) {
		c.run(
			"DELETE FROM run_handoffs WHERE server = ? AND thread_id = ? AND disposition != ?",
			server,
			threadId,
			"pending",
		);
	},
	prune(before) {
		// Terminal and aged pending alike: a pending row that stayed unconfirmed for ITEM_KEEP_MS is abandoned.
		return c.run("DELETE FROM run_handoffs WHERE updated_at < ?", before).changes;
	},
});

/** The wake key for one ended run (matches Candidate.key for turn_ended). */
export const handoffKey = (threadId: string, runId: string) => `${threadId}:ended:${runId}`;

/** Strip store timestamps for the watcher's in-memory record. */
export const asHandoffRecord = (h: PersistedHandoff): HandoffRecord => ({
	threadId: h.threadId,
	runId: h.runId,
	successorId: h.successorId,
	disposition: h.disposition,
});

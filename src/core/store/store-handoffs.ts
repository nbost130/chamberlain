/** Queued-run handoff rows (migration 17 / issue #76): durable disposition across a daemon restart. */
import type { HandoffRecord } from "../steward/handoff.ts";

export type PersistedHandoff = HandoffRecord & {
	server: string;
	observedAt: number;
	updatedAt: number;
};

export interface HandoffStore {
	/** Insert or replace one handoff; on conflict keeps the original observed_at and updates the rest. */
	put(server: string, record: HandoffRecord, now?: number): void;
	get(server: string, threadId: string, runId: string): PersistedHandoff | undefined;
	/** Pending rows for one server (retry after a later state). */
	listPending(server: string): PersistedHandoff[];
	/** Every pending row (all servers): used by maintain to close claimed-but-unconfirmed leftovers. */
	listAllPending(): PersistedHandoff[];
	/**
	 * Pending and rejected rows for one server: loaded into the watcher on start so a restart neither loses an
	 * unconfirmed final nor revives a permanent skip as an ordinary completion.
	 */
	listOpen(server: string): PersistedHandoff[];
	/** Drop terminal dispositions for a thread when a new distinct LIVE→LIVE interval is remembered. */
	clearTerminal(server: string, threadId: string): void;
	/** Delete rows older than `before` (terminal and aged pending). */
	prune(before: number): number;
}

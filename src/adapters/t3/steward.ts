/**
 * What the T3 adapter reads about the Steward's own thread, all from T3's state database, read-only: its context size,
 * and its queue (turns running or queued, stalls, a card of its own that holds it, a compaction already waiting).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { StewardProbe } from "../../core/adapter.ts";
import { compactBlocked, queueStalled, readStewardQueue, stallAlarm } from "./queue.ts";

/** The Steward's context from T3's own record, read-only. Undefined when there is no Steward here or no turn yet. */
function stewardTokens(dbPath: string, threadId: string): number | undefined {
	if (!existsSync(dbPath)) return undefined;
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		return undefined;
	}
	try {
		const row = db
			.query(
				"select json_extract(payload_json, '$.tokenUsage.usedTokens') as used from orchestration_v2_projection_provider_turns where thread_id = ? order by ordinal desc limit 1",
			)
			.get(threadId) as { used: number | null } | null;
		return row?.used ?? undefined;
	} catch {
		// An unknown size only means the full rights go again; it must never cost a wake.
		return undefined;
	} finally {
		db.close();
	}
}

/** The once-a-minute look at the Steward: size, whether the queue reads, whether it has stalled, and whether a compaction may go. */
export function t3Probe(dbPath: string, threadId: string, now = Date.now()): StewardProbe {
	const used = stewardTokens(dbPath, threadId);
	const queue = readStewardQueue(dbPath, threadId);
	return {
		...(used !== undefined ? { contextTokens: used } : {}),
		readable: Boolean(queue),
		...(queue && queueStalled(queue, now) ? { stalled: stallAlarm(queue, now) } : {}),
		compactBlocked: queue ? compactBlocked(queue, now) : "its queue could not be read",
	};
}

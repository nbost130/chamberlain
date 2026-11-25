/**
 * What the T3 adapter reads about the Steward's own thread, all from T3's state database, read-only: its context size,
 * and its queue (turns running or queued, stalls, a card of its own that holds it, a compaction already waiting).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { StewardProbe } from "../../core/adapter/adapter-inspect.ts";
import { readContext } from "./context.ts";
import { compactBlocked, queueStalled, readStewardQueue, stallAlarm } from "./queue.ts";

/** What T3's own record says about the Steward's context and its compactions. Every field is absent when it could not be read. */
type StewardRecord = Omit<StewardProbe, "readable" | "stalled" | "compactBlocked">;
/** A compaction is a `compaction` turn item, completed, on the provider turn that ran it; that turn's own usage is the size AFTER it. */
const COMPACTIONS = `select count(*) as n, max(t.ordinal) as turn from orchestration_v2_projection_turn_items i
	left join orchestration_v2_projection_provider_turns t on t.provider_turn_id = i.provider_turn_id
	where i.thread_id = ? and coalesce(i.provider_thread_id, t.provider_thread_id) = ?
	and i.type = 'compaction' and i.status = 'completed'`;

/**
 * The Steward's context from T3's own record, read-only: the NEWEST turn's size and which turn that is, and nothing older. A turn that has just
 * begun carries no usage yet, and then the size is unknown (undefined). An older turn's sample is never offered in its place: after a
 * compaction it would still read as the large pre-compaction size. A merely unknown size proves nothing either way: the rights record is judged
 * by the compactions counted here (`compactions`: how many have completed; `compactionTurn`: the turn that ran the newest, whose own size is
 * the size after it), by a session or hash change, and by a large drop in size.
 */
function readSteward(dbPath: string, threadId: string, base: string, limit: number): StewardRecord {
	const unavailable: StewardRecord = { context: { unknown: "provider turn database unavailable" } };
	if (!existsSync(dbPath)) return unavailable;
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		return unavailable;
	}
	let out = unavailable;
	try {
		out = readContext(db, threadId, base, limit);
	} catch {
		// An unreadable size only means the callers have nothing to judge a shrink by; it must never cost a wake.
	}
	try {
		const c = out.contextSession
			? db.query<{ n: number; turn: number | null }, [string, string]>(COMPACTIONS).get(threadId, out.contextSession)
			: null;
		if (c) {
			out.compactions = c.n;
			if (c.turn !== null) out.compactionTurn = c.turn;
		}
	} catch {
		// No compaction record readable: no evidence, which is not evidence of none.
	} finally {
		db.close();
	}
	return out;
}

/** The once-a-minute look at the Steward: size, whether the queue reads, whether it has stalled, and whether a compaction may go. */
export function t3Probe(
	dbPath: string,
	threadId: string,
	now = Date.now(),
	options?: { base: string; limit?: number },
): StewardProbe {
	const rec = readSteward(dbPath, threadId, options?.base ?? "", options?.limit ?? 3);
	const queue = readStewardQueue(dbPath, threadId);
	return {
		...rec,
		readable: Boolean(queue),
		...(queue && queueStalled(queue, now) ? { stalled: stallAlarm(queue, now) } : {}),
		compactBlocked: queue ? compactBlocked(queue, now) : "its queue could not be read",
	};
}

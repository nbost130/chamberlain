/**
 * The Steward's own queue, read from T3's state database. A wake that returns 202 has only been queued. Whether the
 * Steward is working through them shows here, and a card in its own thread stops everything behind it.
 */
import { Database } from "bun:sqlite";
import type { Gate } from "../../core/hold.ts";

export const STALL_MS = Number(process.env.CHAMBERLAIN_STALL_MS ?? 20 * 60_000);
export type StewardQueue = {
	queued: number /** Turns the Steward is working on right now. Optional so a literal built without it still reads as none. */;
	running?: number;
	oldestQueuedAt?: string;
	compactPending: boolean;
	lastActivityAt?: string;
	openCardSince?: string;
};

const RUNS = `select r.status as status, r.requested_at as requested_at,
	(select json_extract(m.payload_json, '$.text') from orchestration_v2_projection_messages m where m.message_id = json_extract(r.payload_json, '$.userMessageId')) as text
	from orchestration_v2_projection_runs r where r.thread_id = ? and r.status in ('queued', 'starting', 'preparing', 'running') order by r.ordinal`;
const LAST_START =
	"select max(json_extract(payload_json, '$.startedAt')) as started from orchestration_v2_projection_runs where thread_id = ?";
/** A turn item changing is the Steward at work: none moved in the whole 2026-11-07 stall. Queued wakes are user messages, so they don't count. */
const LAST_ITEM =
	"select max(updated_at) as moved from orchestration_v2_projection_turn_items where thread_id = ? and type != 'user_message'";
/** Only a card raised in the latest turn can hold the Steward. An older unresolved request is an orphan, and must not stop compaction for good. */
const OPEN_CARD =
	"select min(created_at) as since from orchestration_v2_projection_runtime_requests where thread_id = ? and resolved_at is null and created_at >= ?";

/** Undefined when the database can't be read. The caller treats that as unknown, never as a clear queue. */
export function readStewardQueue(dbPath: string, threadId: string): StewardQueue | undefined {
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		return undefined;
	}
	try {
		const runs = db.query(RUNS).all(threadId) as { status: string; requested_at: string; text: string | null }[];
		const queued = runs.filter((r) => r.status === "queued");
		const started = (db.query(LAST_START).get(threadId) as { started: string | null } | null)?.started ?? "";
		const moved = (db.query(LAST_ITEM).get(threadId) as { moved: string | null } | null)?.moved ?? "";
		const card = db.query(OPEN_CARD).get(threadId, started) as { since: string | null } | null;
		return {
			queued: queued.length,
			running: runs.length - queued.length,
			oldestQueuedAt: queued[0]?.requested_at,
			compactPending: runs.some((r) => r.text?.trim() === "/compact"),
			lastActivityAt: (started > moved ? started : moved) || undefined,
			openCardSince: card?.since ?? undefined,
		};
	} catch {
		return undefined;
	} finally {
		db.close();
	}
}

/**
 * Pure: whether the Steward can take a wake now without it queueing behind another turn. Any turn working or queued
 * means busy, a queued /compact included, since a wake would only wait behind it. An unreadable queue is unknown.
 */
export function queueGate(q: StewardQueue | undefined): Gate {
	if (!q) return "unknown";
	return q.queued > 0 || (q.running ?? 0) > 0 ? "busy" : "idle";
}

/** Pure: wakes have waited past the limit and nothing in the thread has moved in that time. A long turn that is working keeps moving. */
export function queueStalled(q: StewardQueue, now: number, stallMs = STALL_MS): boolean {
	if (!q.queued || !q.oldestQueuedAt || now - Date.parse(q.oldestQueuedAt) < stallMs) return false;
	return !q.lastActivityAt || now - Date.parse(q.lastActivityAt) >= stallMs;
}

/** Pure: why a compact must not be sent now. It would only join the queue behind whatever is holding it. */
export function compactBlocked(q: StewardQueue, now: number, stallMs = STALL_MS): string | undefined {
	if (q.compactPending) return "one is already queued or running";
	if (q.openCardSince) return "the Steward has its own card open";
	if (queueStalled(q, now, stallMs)) return "the queue has stopped moving";
	return undefined;
}

/** Pure: the alarm. It says what is blocking and what clears it, so it can be acted on from a phone. */
export function stallAlarm(q: StewardQueue, now: number): { title: string; summary: string } {
	const minutes = Math.round((now - Date.parse(q.oldestQueuedAt as string)) / 60_000);
	const wakes = `${q.queued} wake${q.queued === 1 ? "" : "s"} queued, the oldest for ${minutes} minutes`;
	if (q.openCardSince)
		return {
			title: "The Steward is stopped on a card in its own thread",
			summary: `${wakes}. Answer the open card in the Steward thread and it will carry on. Nothing is supervising threads until then.`,
		};
	return {
		title: "The Steward has stopped taking wakes",
		summary: `${wakes}, and nothing in its thread has moved in that time. Nothing is supervising threads until it does. Open the Steward thread to see what its current turn is doing.`,
	};
}

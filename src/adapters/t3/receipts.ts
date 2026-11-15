/**
 * Read-only evidence that a Steward delivery was input to a completed T3 run (seen-proof).
 * Association: same thread/run, runs.payload_json.userMessageId = messages.message_id, role user,
 * exact fenced Delivery-id content. Template drift fails closed (no receipt).
 */
import { Database } from "bun:sqlite";

/** Matches T3's wake-template line: `Delivery id: <webhook-data-H>ID</webhook-data-H>`. */
const FENCE_RE = /Delivery id:\s*<webhook-data-[^>]+>([^<]*)<\/webhook-data-[^>]+>/g;

export type ReceiptCandidate = {
	outboxId: number;
	deliveryId: string;
	/** Epoch ms; search is narrowed from landedAt - 1h. Wrong bounds only yield "not found". */
	landedAt: number;
	/** Threads to search; empty means every thread (adoption). */
	threads?: string[];
};

export type ReceiptMatch = {
	outboxId: number;
	runId: string;
	thread: string;
	recordedAt: number;
};

/** The last fenced Delivery-id line in a user message, or undefined when the outer template is absent (fail closed). */
export function lastFencedDeliveryId(text: string): string | undefined {
	let last: string | undefined;
	for (const m of text.matchAll(FENCE_RE)) {
		const id = m[1]?.trim();
		if (id) last = id;
	}
	return last;
}

/** Renders the wake template the way T3 does, with a per-delivery fence token. */
export function renderFencedWake(body: string, deliveryId: string, fence = "H"): string {
	return [
		"/steward-wake",
		"",
		"[Chamberlain standing hook.]",
		"",
		"You are the Steward.",
		"",
		body,
		"",
		`Delivery id: <webhook-data-${fence}>${deliveryId}</webhook-data-${fence}>`,
	].join("\n");
}

type MsgRow = {
	message_id: string;
	thread_id: string;
	role: string;
	text: string;
	scheduled: string | null;
	run_id: string;
	status: string;
	user_msg: string | null;
	completed_at: string | null;
};

const EVIDENCE_SQL = `
SELECT m.message_id AS message_id, m.thread_id AS thread_id, m.role AS role,
	json_extract(m.payload_json, '$.text') AS text,
	json_extract(m.payload_json, '$.scheduledTaskId') AS scheduled,
	COALESCE(r.run_id, json_extract(r.payload_json, '$.id')) AS run_id,
	r.status AS status,
	json_extract(r.payload_json, '$.userMessageId') AS user_msg,
	json_extract(r.payload_json, '$.completedAt') AS completed_at
FROM orchestration_v2_projection_messages m
JOIN orchestration_v2_projection_runs r
	ON r.thread_id = m.thread_id
	AND json_extract(r.payload_json, '$.userMessageId') = m.message_id
WHERE m.role = 'user'
	AND json_extract(m.payload_json, '$.scheduledTaskId') IS NOT NULL
	AND r.status = 'completed'
	AND (?1 IS NULL OR m.thread_id = ?1)
	AND (r.requested_at IS NULL OR r.requested_at >= ?2)
`;

function matchRow(row: MsgRow, deliveryId: string): boolean {
	if (row.user_msg !== row.message_id) return false;
	if (!row.scheduled) return false;
	return lastFencedDeliveryId(row.text ?? "") === deliveryId;
}

function hitFromRow(c: ReceiptCandidate, row: MsgRow): ReceiptMatch {
	const at = row.completed_at ? Date.parse(row.completed_at) : Date.now();
	return {
		outboxId: c.outboxId,
		runId: row.run_id,
		thread: row.thread_id,
		recordedAt: Number.isFinite(at) ? at : Date.now(),
	};
}

function scanDb(db: Database, c: ReceiptCandidate): ReceiptMatch | undefined {
	const since = new Date(c.landedAt - 3600_000).toISOString();
	const threads = c.threads?.length ? c.threads : [null];
	for (const thread of threads) {
		for (const row of db.query(EVIDENCE_SQL).all(thread, since) as MsgRow[]) {
			if (matchRow(row, c.deliveryId)) return hitFromRow(c, row);
		}
	}
	return undefined;
}

/** Finds a completed-run receipt for one candidate. Unreadable DB → no match (unseen). */
export function findReceipt(dbPath: string, c: ReceiptCandidate): ReceiptMatch | undefined {
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		return undefined;
	}
	try {
		return scanDb(db, c);
	} catch {
		return undefined;
	} finally {
		db.close();
	}
}

/** Batch evidence: one open, many candidates. */
export function findReceipts(dbPath: string, candidates: ReceiptCandidate[]): ReceiptMatch[] {
	const out: ReceiptMatch[] = [];
	for (const c of candidates) {
		const hit = findReceipt(dbPath, c);
		if (hit) out.push(hit);
	}
	return out;
}

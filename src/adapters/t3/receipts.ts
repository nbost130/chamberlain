/**
 * Read-only evidence that a Steward delivery was input to a completed T3 run (seen-proof).
 * Association: same thread/run, runs.payload_json.userMessageId = messages.message_id, role user,
 * exact fenced Delivery-id content. Template drift fails closed (no receipt).
 */
import { Database } from "bun:sqlite";

/**
 * Approved outer line: matching open/close fence tokens, exact fenced content (no trim).
 * Only a well-formed **final** line counts (R4); a malformed terminal template yields no evidence.
 */
const FINAL_FENCE_RE = /^Delivery id: <webhook-data-([A-Za-z0-9]+)>([^<\r\n]*)<\/webhook-data-\1>$/;

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

/** The authoritative final fenced Delivery-id line, or undefined when the outer template is absent/malformed (fail closed). */
export function lastFencedDeliveryId(text: string): string | undefined {
	const lines = text.split("\n");
	let end = lines.length - 1;
	while (end >= 0 && lines[end] === "") end--;
	const last = end >= 0 ? lines[end] : undefined;
	if (last === undefined) return undefined;
	const m = FINAL_FENCE_RE.exec(last);
	const id = m?.[2];
	return id || undefined;
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

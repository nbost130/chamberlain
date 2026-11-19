/** Reading the Steward's transcript for its health: replies, thread reads and tool uses, line by line. */
import type { MeasureOptions } from "./steward-health.ts";
import { HEALTH_CONFIG } from "./steward-health-config.ts";

/** One canonical transcript row, as far as the health check reads it. Rows come from JSON, so every field may be missing or odd. */
type Row = {
	isSidechain?: unknown;
	type?: string;
	subtype?: string;
	timestamp: string;
	uuid: string;
	rendered?: unknown;
	attachment?: { type?: string; hookEvent?: string };
	message?: { role?: string; usage?: Usage; content?: unknown };
};
type Usage = { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
type ToolUse = { type?: string; id?: string; name?: unknown; input?: Record<string, unknown> };

/** What one pass over a transcript has seen since the last compaction boundary. */
export type Scan = {
	tokens?: number;
	peakTokens?: number;
	usageAt?: string;
	boundary?: string;
	slips: boolean[];
	selfReads: number;
	threadRereads: number;
	tools: Set<string>;
	hooks: Set<string>;
	threads: Map<string, number>;
	unknown: Set<string>;
	/** The turn the next assistant rows belong to (set by each user prompt): what its self-reads are for. */
	turn: Turn;
	/** User turns still counted as recovery after the last compaction boundary. */
	recoveryLeft: number;
};

/**
 * What the turn being read was started by. A self-read made for the hand-off itself, to recover after a compaction, or to check a wake's
 * delivery id for a repeat is the Steward doing what it was told: never a sign of wear (the hand-off verdict used to fire on its own work).
 */
export type Turn = { handoff: boolean; recovery: boolean; deliveryIds: string[] };
export const ORDINARY_TURN: Turn = { handoff: false, recovery: false, deliveryIds: [] };
/** The user turns after a compaction boundary (the continuation summary, then the first wake) in which the Steward rebuilds what the summary dropped. */
export const RECOVERY_TURNS = 2;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A compaction boundary starts the measurement over: nothing before it says anything about the context now. */
function resetAtBoundary(scan: Scan, timestamp: string) {
	scan.tokens = undefined;
	scan.peakTokens = undefined;
	scan.usageAt = undefined;
	scan.boundary = timestamp;
	scan.slips = [];
	scan.selfReads = 0;
	scan.threadRereads = 0;
	scan.tools.clear();
	scan.hooks.clear();
	scan.threads.clear();
	scan.unknown.clear();
	scan.turn = ORDINARY_TURN;
	scan.recoveryLeft = RECOVERY_TURNS;
}

/** The text of a user prompt row: its string, or its text blocks. A row of tool results is not a new turn and gives undefined. */
function promptText(r: Row): string | undefined {
	const c = r.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return undefined;
	const blocks = c as { type?: string; text?: unknown }[];
	if (blocks.some((b) => b.type === "tool_result")) return undefined;
	return blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** A hand-off turn: the `steward-handoff` skill, its wake, or the instruction that starts it. */
const HANDOFF_TURN = /steward-handoff|Hand the Steward role to a fresh thread/;
/** The delivery id a wake ends with (`delivery id: <id> (the same id again is a repeat...)`). */
const DELIVERY_ID = /delivery id: (\S+)/g;

/** A user prompt starts a turn: what it is for decides which of its own-transcript reads are the Steward's wear and which are its work. */
function noteUserTurn(scan: Scan, r: Row) {
	const text = promptText(r);
	if (text === undefined) return;
	scan.turn = {
		handoff: HANDOFF_TURN.test(text),
		recovery: scan.recoveryLeft > 0,
		deliveryIds: [...text.matchAll(DELIVERY_ID)].map((m) => m[1] as string),
	};
	if (scan.recoveryLeft > 0) scan.recoveryLeft--;
}

/** A UserPromptSubmit hook's text that matches the format pattern is one graded reply, counted once per hook row. */
function noteReplyHook(scan: Scan, r: Row, formatPattern: RegExp | undefined) {
	if (
		r.type !== "attachment" ||
		r.attachment?.type !== "hook_additional_context" ||
		r.attachment?.hookEvent !== "UserPromptSubmit"
	)
		return;
	const text = typeof r.rendered === "string" ? r.rendered : JSON.stringify(r.attachment ?? {});
	const hit = formatPattern ? text.match(formatPattern) : null;
	if (hit && !scan.hooks.has(r.uuid)) {
		scan.hooks.add(r.uuid);
		scan.slips.push(String(hit[1] ?? "").startsWith("broke"));
		scan.slips = scan.slips.slice(-HEALTH_CONFIG.replies);
	}
}

/** Latest assistant usage is a snapshot, never a sum across responses or streaming blocks. */
function noteUsage(scan: Scan, r: Row) {
	const u = r.message?.usage;
	if (!u) return;
	const values = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
	scan.tokens = values.every(isCount) ? values.reduce((a, b) => a + b, 0) : undefined;
	if (scan.tokens !== undefined) scan.peakTokens = Math.max(scan.peakTokens ?? 0, scan.tokens);
	scan.usageAt = r.timestamp;
}

/** Does this tool call look a wake's delivery id up, to find out whether it is a repeat? (The wake text itself tells the Steward to.) */
function checksDeliveryId(name: string, input: Record<string, unknown>, ids: string[]): boolean {
	const text = name === "Bash" ? String(input.command ?? "") : String(input.pattern ?? "");
	return ids.some((id) => id.length > 0 && text.includes(id));
}

/** Does this tool call read the Steward's own transcript file? */
function readsOwnTranscript(name: string, input: Record<string, unknown>, session: string): boolean {
	if (name === "Read") return String(input.file_path ?? "").endsWith(`/${session}.jsonl`);
	if (name !== "Bash") return false;
	const command = String(input.command ?? "");
	return /\b(cat|tail|head|sed|rg|grep|readFileSync|readFile)\b/.test(command) && command.includes(`${session}.jsonl`);
}

/** Another read of the same thread inside the window is a repeat; a read with no usable time says nothing and is reported unknown. */
function noteThreadRead(scan: Scan, key: string, timestamp: string) {
	const time = Date.parse(timestamp),
		prior = scan.threads.get(key);
	if (!Number.isFinite(time)) {
		scan.unknown.add("read timestamp missing");
		return;
	}
	if (prior !== undefined && time >= prior && time - prior <= HEALTH_CONFIG.windowMs) scan.threadRereads++;
	scan.threads.set(key, time);
}

/** A self-read counts toward the rereading limit only when it is neither the hand-off's, a recovery after a compaction, nor a repeat check of a wake's delivery id. */
function countsAsWear(turn: Turn, name: string, input: Record<string, unknown>): boolean {
	return !turn.handoff && !turn.recovery && !checksDeliveryId(name, input, turn.deliveryIds);
}

/** Each tool call once (by its id): whether it rereads the transcript, and whether it rereads another thread. */
function noteToolUses(scan: Scan, r: Row, session: string, opts: MeasureOptions) {
	const content = r.message?.content;
	for (const c of (Array.isArray(content) ? content : []) as ToolUse[]) {
		if (c.type !== "tool_use" || !c.id || scan.tools.has(c.id)) continue;
		scan.tools.add(c.id);
		const input = c.input ?? {},
			name = String(c.name);
		if (readsOwnTranscript(name, input, session) && countsAsWear(scan.turn, name, input)) scan.selfReads++;
		const key = opts.threadReadKey?.(name, input);
		if (key) noteThreadRead(scan, key, r.timestamp);
	}
}

/** Folds one transcript line into the scan. */
export function scanLine(scan: Scan, line: string, session: string, opts: MeasureOptions) {
	if (!line.trim()) return;
	let r: Row;
	try {
		r = JSON.parse(line);
	} catch {
		scan.unknown.add("malformed transcript row");
		return;
	}
	if (r.isSidechain) return;
	if (r.type === "system" && r.subtype === "compact_boundary") {
		resetAtBoundary(scan, r.timestamp);
		return;
	}
	noteReplyHook(scan, r, opts.formatPattern);
	if (r.type === "user" || r.message?.role === "user") noteUserTurn(scan, r);
	if (r.type !== "assistant") return;
	noteUsage(scan, r);
	noteToolUses(scan, r, session, opts);
}

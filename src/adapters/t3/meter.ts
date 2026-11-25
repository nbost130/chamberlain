import { Database } from "bun:sqlite";
import type { StewardMeterRead, StewardQuality } from "../../core/adapter/steward-meter.ts";
import { HEALTH_CONFIG } from "../../core/steward/steward-health-config.ts";
import { type MeterTurn, meterTurns, TURN_LIMIT, turnRow } from "./meter-turns.ts";
import { threadReadKey } from "./transcript.ts";

const ITEM_LIMIT = 2048;
const ITEM_BUDGET = 12_000;
const ITEMS = `SELECT type, status, json_extract(payload_json, '$.toolName') AS tool,
	case when length(json_extract(payload_json, '$.input')) <= 16384
		then json_extract(payload_json, '$.input') end AS input,
	json_extract(payload_json, '$.startedAt') AS started
	FROM orchestration_v2_projection_turn_items
	WHERE provider_turn_id = ? AND thread_id = ?
	AND type IN ('dynamic_tool', 'command_execution', 'compaction')
	ORDER BY ordinal LIMIT ?`;

type Item = {
	type: string;
	status: string;
	tool: string | null;
	input: string | null;
	started: string | null;
};

function toolCall(item: Item) {
	if (item.type === "command_execution") return { name: "Bash", args: { command: item.input } };
	const input = item.input ? JSON.parse(item.input) : {};
	return { name: item.tool ?? "", args: input && typeof input === "object" ? input : {} };
}

function ownTranscriptRead(name: string, args: Record<string, unknown>, session: string, deliveryId?: string) {
	const query = String(args.command ?? args.pattern ?? "");
	if (deliveryId && query.includes(deliveryId)) return false;
	if (name === "Read") return String(args.file_path ?? "").endsWith(`/${session}.jsonl`);
	return (
		name === "Bash" &&
		/\b(cat|tail|head|sed|rg|grep|readFileSync|readFile)\b/.test(query) &&
		query.includes(`${session}.jsonl`)
	);
}

function observations(items: Item[], turn: MeterTurn, deliveryId?: string) {
	const reads: { key: string; at: number }[] = [];
	let selfReads = 0;
	for (const item of items) {
		const { name, args } = toolCall(item);
		const key = threadReadKey(name, args);
		if (key) reads.push({ key, at: Date.parse(item.started ?? "") });
		if (
			turn.driver === "claudeAgent" &&
			turn.nativeSession &&
			ownTranscriptRead(name, args, turn.nativeSession, deliveryId)
		)
			selfReads++;
	}
	return { reads, selfReads };
}

function qualityOf(
	turns: ReturnType<typeof inspectTurn>[],
	active: string,
	truncated: boolean,
): StewardQuality | undefined {
	const own = turns.filter((t) => t.turn.session === active);
	if (!own.length) return undefined;
	const boundaryIndex = own.findIndex((t) => t.row.compactions > 0);
	const boundary = boundaryIndex < 0 ? undefined : own[boundaryIndex]?.turn.completed;
	const recent = (boundaryIndex < 0 ? own : own.slice(0, boundaryIndex)).reverse();
	const canReadSelf = own[0]?.row.nativeSession !== undefined;
	const reads = recent.flatMap((t) => t.reads).sort((a, b) => a.at - b.at);
	const previous = new Map<string, number>();
	let threadRereads = 0;
	let incomplete = (!boundary && truncated) || recent.some((t) => t.truncated);
	for (const { key, at } of reads) {
		if (!Number.isFinite(at)) {
			incomplete = true;
			continue;
		}
		const prior = previous.get(key);
		if (prior !== undefined && at - prior <= HEALTH_CONFIG.windowMs) threadRereads++;
		previous.set(key, at);
	}
	const selfReads = recent.reduce(
		(n, t, i) => n + ((boundary && i < 2) || ["handoff", "steward-handoff"].includes(t.row.kind) ? 0 : t.selfReads),
		0,
	);
	return {
		threadRereads,
		...(canReadSelf ? { selfReads } : {}),
		...(boundary ? { boundary } : {}),
		...(incomplete ? { unknown: "turn-item coverage incomplete" } : {}),
	};
}

function inspectTurn(t: MeterTurn, items: Item[], limit: number) {
	const row = turnRow(
		t,
		items.some((i) => i.type === "compaction" && i.status === "completed"),
	);
	const tools = items.filter((i) => i.type !== "compaction");
	const complete = limit > 0 && items.length <= limit;
	const truncated = !complete || tools.some((i) => i.input === null);
	const { reads, selfReads } = observations(tools.slice(0, limit), t, row.deliveryId);
	if (truncated) row.unknown = [row.unknown, "tool fields incomplete"].filter(Boolean).join("; ");
	if (complete) row.toolCalls = tools.length;
	if (!truncated) row.threadReads = reads.length;
	return { turn: t, row, reads, selfReads, truncated };
}

function readMeter(db: Database, thread: string, since: number, quality: boolean): StewardMeterRead {
	const turns = meterTurns(db, thread, since);
	const items = db.query<Item, [string, string, number]>(ITEMS);
	let remaining = ITEM_BUDGET;
	const records = turns.slice(0, TURN_LIMIT).map((t) => {
		const limit = Math.min(ITEM_LIMIT, remaining);
		const rows = limit > 0 ? items.all(t.id, thread, limit + 1) : [];
		remaining = Math.max(0, remaining - rows.length);
		return inspectTurn(t, rows, limit);
	});
	const rows = records.map((r) => r.row).filter((r) => r.startedAt <= r.endedAt);
	const partial = turns.length > TURN_LIMIT || rows.length !== records.length ? "turn history incomplete" : undefined;
	if (!quality) return { rows, partial };
	const active = db
		.query<{ session: string }, [string]>(
			"SELECT active_provider_thread_id AS session FROM orchestration_v2_projection_threads WHERE thread_id = ?",
		)
		.get(thread);
	return { rows, partial, quality: active ? qualityOf(records, active.session, turns.length > TURN_LIMIT) : undefined };
}

/** Bound all reads to one thread and one SQLite snapshot. No input text or tool arguments leave the adapter. */
export function t3Meter(dbPath: string, thread: string, since: number, quality = false): StewardMeterRead {
	try {
		using db = new Database(dbPath, { readonly: true });
		return db.transaction(() => readMeter(db, thread, since, quality))();
	} catch {
		return { unknown: "turn records unavailable" };
	}
}

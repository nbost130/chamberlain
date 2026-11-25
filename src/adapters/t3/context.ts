import type { Database } from "bun:sqlite";
import type { ContextReading, StewardProbe } from "../../core/adapter/adapter-inspect.ts";
import { nativeContext } from "./context-native.ts";

const ACTIVE = `select t.active_provider_thread_id as session, json_extract(p.payload_json, '$.driver') as driver,
	json_extract(p.payload_json, '$.providerInstanceId') as instance,
	json_extract(p.payload_json, '$.nativeThreadRef.nativeId') as conversation
	from orchestration_v2_projection_threads t
	join orchestration_v2_projection_provider_threads p on p.provider_thread_id = t.active_provider_thread_id
	where t.thread_id = ?`;
const TURNS = `select ordinal, status, started_at as started, completed_at as completed,
	case when json_type(payload_json, '$.tokenUsage.usedTokens') = 'integer'
		then json_extract(payload_json, '$.tokenUsage.usedTokens') end as used,
	case json_type(payload_json, '$.tokenUsage.maxTokens')
		when 'integer' then json_extract(payload_json, '$.tokenUsage.maxTokens')
		when 'null' then null else json_type(payload_json, '$.tokenUsage.maxTokens') end as window,
	json_extract(payload_json, '$.tokenUsage.updatedAt') as at,
	json_extract(payload_json, '$.nativeTurnRef.driver') as nativeDriver,
	json_extract(payload_json, '$.nativeTurnRef.nativeId') as nativeId
	from orchestration_v2_projection_provider_turns where thread_id = ? and provider_thread_id = ?
	and (status = 'completed' or ordinal = (
		select max(ordinal) from orchestration_v2_projection_provider_turns where thread_id = ? and provider_thread_id = ?
	))
	order by ordinal desc limit ?`;
const UNSUPPORTED = `select 1 from orchestration_v2_projection_turn_items where thread_id = ?
	and provider_thread_id = ? and type = 'error' and json_extract(payload_json, '$.failure.message') = ?
	limit 1`;
const UNSUPPORTED_MESSAGE =
	"This provider does not support /compact. Start a new thread to continue with a fresh context.";

type Turn = {
	ordinal: number;
	status: string;
	started: string | null;
	completed: string | null;
	used: unknown;
	window: unknown;
	at: string | null;
	nativeDriver: string | null;
	nativeId: string | null;
};
type Active = { session: string; driver: string | null; instance: string | null; conversation: string | null };
type ContextFacts = Pick<
	StewardProbe,
	| "context"
	| "contextTokens"
	| "contextTurn"
	| "contextSession"
	| "completedTurn"
	| "previousCompletedTurn"
	| "unknownTurns"
	| "canCompact"
	| "retryLostCompact"
	| "partialContextHistory"
>;

const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const timestamp = (v: string | null) => (v ? Date.parse(v) : NaN);

function projection(turn: Turn): ContextReading | undefined {
	const { used: tokens, window, at } = turn;
	if (!positive(tokens) || (window != null && (!positive(window) || tokens > window))) return undefined;
	const started = timestamp(turn.started);
	if (!at || !Number.isFinite(started) || !Number.isFinite(timestamp(at)) || timestamp(at) < started) return undefined;
	return { tokens, ...(positive(window) ? { window } : {}), at, source: "provider turn" };
}

function newestContext(turn: Turn, active: Active, base: string): ContextReading {
	const direct = projection(turn);
	if (direct) return direct;
	const { driver, instance, conversation } = active;
	if (driver !== "antigravity") return { unknown: "newest turn has no valid context measurement" };
	const at = turn.completed;
	if (
		turn.status !== "completed" ||
		turn.nativeDriver !== driver ||
		!instance ||
		!conversation ||
		turn.nativeId !== `${conversation}:turn:${turn.ordinal}` ||
		!at ||
		!Number.isFinite(timestamp(at))
	)
		return { unknown: "newest turn has no completed native conversation reference" };
	const native = nativeContext(base, instance, conversation, timestamp(turn.started));
	return native ? { ...native, at, source: "native request" } : { unknown: "native context unavailable" };
}

function completion(turns: Turn[], driver: string | null): ContextFacts {
	const done = turns.filter((turn) => turn.status === "completed");
	const current = done[0];
	if (!current) return {};
	const firstKnown = done.findIndex((turn) => projection(turn) !== undefined);
	const projectedUnknown = firstKnown < 0 ? done : done.slice(0, firstKnown);
	const partialContextHistory = driver === "antigravity";
	return {
		completedTurn: current.ordinal,
		previousCompletedTurn: done[1]?.ordinal,
		// A historical projection cannot tell whether a native read of an earlier turn succeeded.
		partialContextHistory,
		unknownTurns: (partialContextHistory ? projectedUnknown.slice(0, 1) : projectedUnknown).map((turn) => turn.ordinal),
	};
}

function compactUnsupported(db: Database, thread: string, session: string): boolean | undefined {
	try {
		return db.query(UNSUPPORTED).get(thread, session, UNSUPPORTED_MESSAGE) ? false : undefined;
	} catch {
		// Reading the separate error table is not a prerequisite for reading measured context.
		return undefined;
	}
}

function readSnapshot(db: Database, thread: string, base: string, limit: number): ContextFacts {
	const active = db.query<Active, [string]>(ACTIVE).get(thread);
	if (!active) return { context: { unknown: "active provider thread unavailable" } };
	const { session, driver } = active;
	const turns = db
		.query<Turn, [string, string, string, string, number]>(TURNS)
		.all(thread, session, thread, session, limit + 2);
	const newest = turns[0];
	const context: ContextReading = newest
		? newestContext(newest, active, base)
		: { unknown: "active provider thread has no turns" };
	return {
		context,
		contextSession: session,
		contextTurn: newest?.ordinal,
		canCompact: compactUnsupported(db, thread, session),
		retryLostCompact: driver === "claudeAgent",
		...completion(turns, driver),
		...("tokens" in context ? { contextTokens: context.tokens } : {}),
	};
}

export function readContext(db: Database, thread: string, base: string, limit: number): ContextFacts {
	return db.transaction(() => readSnapshot(db, thread, base, limit))();
}

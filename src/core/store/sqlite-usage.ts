import type { Db, Row } from "./sqlite-db.ts";
import type { UsageStore, WakeUsage } from "./store-records.ts";

const UPSERT_USAGE = `INSERT INTO steward_wake_usage (session, wake_key, kind, variant, delivery_id, started_at, ended_at, requests, input_tokens,
								cache_read_input_tokens, cache_creation_input_tokens, output_tokens, context_start, context_end, context_peak, compactions,
								tool_calls, thread_reads)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT (session, wake_key) DO UPDATE SET kind = excluded.kind, variant = excluded.variant, delivery_id = excluded.delivery_id,
								started_at = excluded.started_at, ended_at = excluded.ended_at, requests = excluded.requests, input_tokens = excluded.input_tokens,
								cache_read_input_tokens = excluded.cache_read_input_tokens, cache_creation_input_tokens = excluded.cache_creation_input_tokens,
								output_tokens = excluded.output_tokens, context_start = excluded.context_start, context_end = excluded.context_end,
								context_peak = excluded.context_peak, compactions = excluded.compactions, tool_calls = excluded.tool_calls,
								thread_reads = excluded.thread_reads`;

const usageParams = (r: WakeUsage): unknown[] => [
	r.session,
	r.wakeKey,
	r.kind,
	r.variant ?? null,
	r.deliveryId ?? null,
	r.startedAt,
	r.endedAt,
	r.requests ?? null,
	r.inputTokens ?? null,
	r.cacheReadInputTokens ?? null,
	r.cacheCreationInputTokens ?? null,
	r.outputTokens ?? null,
	r.contextStart ?? null,
	r.contextEnd ?? null,
	r.contextPeak ?? null,
	r.compactions,
	r.toolCalls ?? null,
	r.threadReads ?? null,
];

const toWakeUsage = (r: Row): WakeUsage => {
	const opt = (v: unknown) => (v === null || v === undefined ? undefined : (v as number));
	const w: WakeUsage = {
		source: "transcript",
		session: r.session as string,
		wakeKey: r.wake_key as string,
		kind: r.kind as string,
		startedAt: r.started_at as number,
		endedAt: r.ended_at as number,
		requests: r.requests as number,
		inputTokens: r.input_tokens as number,
		cacheReadInputTokens: r.cache_read_input_tokens as number,
		cacheCreationInputTokens: r.cache_creation_input_tokens as number,
		outputTokens: r.output_tokens as number,
		compactions: r.compactions as number,
	};
	if (r.variant !== null) w.variant = r.variant as string;
	if (r.delivery_id !== null) w.deliveryId = r.delivery_id as string;
	for (const [key, col] of [
		["contextStart", "context_start"],
		["contextEnd", "context_end"],
		["contextPeak", "context_peak"],
		["toolCalls", "tool_calls"],
		["threadReads", "thread_reads"],
	] as const) {
		const v = opt(r[col]);
		if (v !== undefined) w[key] = v;
	}
	return w;
};

type UsageQuery = NonNullable<Parameters<UsageStore["list"]>[0]>;

const METER_KEYS = "key >= 'steward-meter:' AND key < 'steward-meter;'";

/** An additive index over existing keys. Older builds can still open and write the same schema version. */
export function ensureUsageIndex(c: Db) {
	c.run(`CREATE INDEX IF NOT EXISTS steward_meter_by_time ON state (updated_at) WHERE ${METER_KEYS}`);
}

function listUsage(c: Db, q: UsageQuery = {}): WakeUsage[] {
	const where: string[] = [],
		p: unknown[] = [];
	if (q.since !== undefined) {
		where.push("started_at >= ?");
		p.push(q.since);
	}
	if (q.session !== undefined) {
		where.push("session = ?");
		p.push(q.session);
	}
	const history = c
		.all(
			`SELECT * FROM steward_wake_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at, session, wake_key`,
			...p,
		)
		.map(toWakeUsage);
	const recorded = c
		.all(
			`SELECT value FROM state INDEXED BY steward_meter_by_time WHERE ${METER_KEYS} AND updated_at >= ?`,
			q.since ?? 0,
		)
		.map((r) => JSON.parse(r.value as string) as WakeUsage);
	return reconcileUsage(history, q.transcriptOnly ? recorded.filter((r) => r.source === "transcript") : recorded, q);
}

/** The optional history supplies only otherwise uncovered turns. A source never contributes a second count for a covered turn. */
function reconcileUsage(history: WakeUsage[], recorded: WakeUsage[], q: UsageQuery): WakeUsage[] {
	const key = (r: WakeUsage) => JSON.stringify([r.session, r.wakeKey]);
	const replacements = new Set(recorded.map(key));
	const covered = coveredByProjection(recorded);
	return [...history.filter((r) => !replacements.has(key(r))), ...recorded]
		.filter((r) => (!q.session || r.session === q.session) && r.startedAt >= (q.since ?? 0) && !covered(r))
		.sort(
			(a, b) => a.startedAt - b.startedAt || a.session.localeCompare(b.session) || a.wakeKey.localeCompare(b.wakeKey),
		);
}

function coveredByProjection(recorded: WakeUsage[]) {
	const bySession = new Map<string, WakeUsage[]>();
	const byDelivery = new Map<string, WakeUsage[]>();
	for (const row of recorded) {
		if (row.source !== "turn record") continue;
		if (row.nativeSession) addToIndex(bySession, row.nativeSession, row);
		else if (row.deliveryId) addToIndex(byDelivery, row.deliveryId, row);
	}
	return (row: WakeUsage) => {
		if (row.source === "turn record") return false;
		const matchesSession = bySession
			.get(row.session)
			?.some(
				(turn) =>
					(row.startedAt >= (turn.requestedAt ?? turn.startedAt) && row.startedAt <= turn.endedAt) ||
					matchingDelivery(row, turn),
			);
		return (
			matchesSession ||
			Boolean(row.deliveryId && byDelivery.get(row.deliveryId)?.some((turn) => matchingDelivery(row, turn)))
		);
	};
}

function addToIndex(index: Map<string, WakeUsage[]>, key: string, row: WakeUsage) {
	const rows = index.get(key);
	if (rows) rows.push(row);
	else index.set(key, [row]);
}

function matchingDelivery(row: WakeUsage, turn: WakeUsage) {
	return (
		Boolean(row.deliveryId) &&
		row.deliveryId === turn.deliveryId &&
		row.endedAt >= (turn.requestedAt ?? turn.startedAt) &&
		row.startedAt <= turn.endedAt
	);
}

export const makeUsage = (c: Db): UsageStore => ({
	upsert(rows: WakeUsage[]) {
		c.tx(() => {
			for (const r of rows) {
				if (r.source !== "turn record" && !r.unknown) c.run(UPSERT_USAGE, ...usageParams(r));
				const key = `steward-meter:${JSON.stringify([r.session, r.wakeKey])}`;
				if (r.source === "turn record" || r.model || r.unknown)
					c.run(
						"INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)",
						key,
						JSON.stringify({ source: "transcript", ...r }),
						r.endedAt,
					);
				else c.run("DELETE FROM state WHERE key = ?", key);
			}
		});
	},
	list: (q) => listUsage(c, q),
});

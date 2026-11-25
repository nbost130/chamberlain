import type { Database } from "bun:sqlite";
import { classifyPrompt, type Prompt } from "../../core/steward/steward-segments.ts";
import type { WakeUsage } from "../../core/store/store-records.ts";
import { lastFencedDeliveryId } from "./receipts.ts";

export const TURN_LIMIT = 1024;
const TEXT_LIMIT = 256 * 1024;

const TURNS = `WITH recent AS MATERIALIZED (
	SELECT * FROM orchestration_v2_projection_provider_turns
	WHERE thread_id = ?1 AND completed_at IS NOT NULL AND completed_at >= ?2
	ORDER BY started_at DESC, provider_turn_id DESC LIMIT ?3
)
SELECT t.provider_turn_id AS id, t.provider_thread_id AS session, t.ordinal,
	t.started_at AS started, t.completed_at AS completed, r.requested_at AS requested,
	p.driver AS driver, json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS nativeSession,
	json_extract(t.payload_json, '$.turnTokenUsage') AS usage,
	coalesce(json_extract(t.payload_json, '$.executedModel'), json_extract(a.payload_json, '$.executedModel')) AS model,
	case when length(m.payload_json) <= ?4 then json_extract(m.payload_json, '$.text') end AS prompt,
	m.message_id AS message, json_extract(m.payload_json, '$.scheduledTaskId') AS scheduled
FROM recent t
JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id AND p.thread_id = t.thread_id
LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id AND a.thread_id = t.thread_id
LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id AND r.thread_id = t.thread_id
LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
	AND m.thread_id = t.thread_id AND m.role = 'user'
ORDER BY t.started_at DESC, t.provider_turn_id DESC`;

export type MeterTurn = {
	id: string;
	session: string;
	ordinal: number;
	started: string;
	completed: string;
	requested: string | null;
	driver: string;
	nativeSession: string | null;
	usage: string | null;
	model: string | null;
	prompt: string | null;
	message: string | null;
	scheduled: string | null;
};

export function meterTurns(db: Database, thread: string, since: number) {
	return db
		.query<MeterTurn, [string, string, number, number]>(TURNS)
		.all(thread, new Date(since).toISOString(), TURN_LIMIT + 1, TEXT_LIMIT);
}

const count = (n: unknown): number | undefined =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;

function tokenFields(raw: string | null): Partial<WakeUsage> {
	const u = raw ? JSON.parse(raw) : undefined;
	if (u?.usageScope !== "main_agent" || !["complete", "partial"].includes(u.usageStatus))
		return { tokensIncomplete: true, unknown: "turn tokens unavailable" };
	const input = count(u.inputTokens);
	const read = count(u.cachedInputTokens);
	const write = count(u.cacheCreationTokens);
	const output = count(u.outputTokens);
	const reasoning = count(u.reasoningTokens);
	// The projection's input includes both cache categories. The store and price table use
	// disjoint categories. Reasoning is reported independently, never added to output again.
	const uncached =
		input !== undefined && read !== undefined && write !== undefined && input >= read + write
			? input - read - write
			: undefined;
	const complete = u.usageStatus === "complete" && uncached !== undefined && output !== undefined;
	return {
		...(uncached !== undefined ? { inputTokens: uncached } : {}),
		...(read !== undefined ? { cacheReadInputTokens: read } : {}),
		...(write !== undefined ? { cacheCreationInputTokens: write } : {}),
		...(output !== undefined ? { outputTokens: output } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
		...(!complete ? { tokensIncomplete: true, unknown: "turn token fields incomplete" } : {}),
	};
}

function turnPrompt(t: MeterTurn, haveCompaction: boolean): Prompt {
	const prompt = t.prompt ?? "";
	// Trust a delivery id only from the webhook envelope associated with this run's own user message.
	const deliveryId =
		t.scheduled && /^scheduled-task-message:.+:webhook:delivery:/.test(t.message ?? "")
			? lastFencedDeliveryId(prompt)
			: undefined;
	if (prompt.trim() === "/compact" || (!prompt && haveCompaction)) return { kind: "compact" };
	if (/^\s*\/steward-handoff(?:\s|$)/.test(prompt)) return { kind: "steward-handoff" };
	if (deliveryId) return wakePrompt(prompt, deliveryId);
	const classified = classifyPrompt(prompt);
	return { kind: classified?.kind === "start" || classified?.kind === "notice" ? classified.kind : "message" };
}

function wakePrompt(prompt: string, deliveryId: string) {
	const prefix = /^\/steward-wake\b[\s\S]*?\n\n(?=\[(?:chamberlain|t3-wake)\] )/.exec(prompt.slice(0, 2000));
	const classified = classifyPrompt(prefix ? prompt.slice(prefix[0].length) : prompt);
	const kind = classified?.kind;
	return { kind: kind && kind !== "message" ? kind : "wake", deliveryId, variant: classified?.variant };
}
export function turnRow(t: MeterTurn, haveCompaction: boolean): WakeUsage {
	const { kind, variant, deliveryId } = turnPrompt(t, haveCompaction);
	const model = t.model && /^[a-z0-9][a-z0-9_.:/@+-]*(?:\[[a-z0-9]+\])?$/i.test(t.model) ? t.model : undefined;
	const requestedAt = Date.parse(t.requested ?? "");
	return {
		session: t.session,
		wakeKey: String(t.ordinal),
		kind,
		...(kind === "sweep" && variant ? { variant } : {}),
		...(deliveryId ? { deliveryId } : {}),
		startedAt: Date.parse(t.started),
		endedAt: Date.parse(t.completed),
		...(Number.isFinite(requestedAt) ? { requestedAt } : {}),
		source: "turn record",
		...(model ? { model } : {}),
		...(t.driver === "claudeAgent" && t.nativeSession ? { nativeSession: t.nativeSession } : {}),
		compactions: Number(haveCompaction),
		...tokenFields(t.usage),
	};
}

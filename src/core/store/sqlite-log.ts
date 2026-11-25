/** The event log and the classifier's dispositions. */

import { type Db, parse, type Row, required } from "./sqlite-db.ts";
import type { EventQuery, LogEvent, Store } from "./store.ts";
import type { Disposition, DispositionKey, DispositionWrite } from "./store-records.ts";

// ---- events -------------------------------------------------------------------------------------
const toEvent = (r: Row): LogEvent => ({
	t: r.t as string,
	...(r.src ? { src: r.src as string } : {}),
	...(parse<Record<string, unknown>>(r.data) ?? {}),
	event: r.event as string,
});
const eventWhere = (q: EventQuery) => {
	const where: string[] = [],
		p: unknown[] = [];
	if (q.since !== undefined) {
		where.push("t >= ?");
		p.push(q.since);
	}
	if (q.until !== undefined) {
		where.push("t < ?");
		p.push(q.until);
	}
	if (q.events?.length) {
		where.push(`event IN (${q.events.map(() => "?").join(",")})`);
		p.push(...q.events);
	}
	if (q.src !== undefined) {
		where.push("src = ?");
		p.push(q.src);
	}
	return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", p };
};
const BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i;
const appendEvent = (c: Db, e: LogEvent, importKey?: string) => {
	const { t, event, src, ...data } = e;
	c.run(
		"INSERT INTO events (t, event, src, data, import_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT (import_key) DO NOTHING",
		t,
		event,
		src ?? null,
		JSON.stringify(data),
		importKey ?? null,
	);
};
export const makeEvents = (c: Db): Store["events"] => ({
	append: (e, importKey) => {
		appendEvent(c, e, importKey);
	},
	tryAppendMany(lines) {
		try {
			c.nowait(() =>
				c.tx(() => {
					for (const [e, key] of lines) appendEvent(c, e, key);
				}),
			);
			return true;
		} catch (err) {
			if (BUSY.test(String(err))) return false;
			throw err;
		}
	},
	query(q = {}) {
		const w = eventWhere(q);
		return c
			.all(`SELECT * FROM events ${w.sql} ORDER BY id ${q.limit ? `LIMIT ${Math.floor(q.limit)}` : ""}`, ...w.p)
			.map(toEvent);
	},
	count: (q = {}) => {
		const w = eventWhere(q);
		return required(c.one(`SELECT COUNT(*) AS n FROM events ${w.sql}`, ...w.p), "event count").n as number;
	},
	prune: (before) => c.run("DELETE FROM events WHERE t < ?", before).changes,
});

// ---- the classifier's dispositions (migration 13) ---------------------------------------------------
const KEY_WHERE = "server = ? AND thread_id = ? AND message_hash = ? AND bank_version = ?";
const keyArgs = (k: DispositionKey) => [k.server, k.threadId, k.messageHash, k.bankVersion];
const toDisposition = (r: Row): Disposition => ({
	server: r.server as string,
	threadId: r.thread_id as string,
	messageHash: r.message_hash as string,
	bankVersion: r.bank_version as string,
	classifiedAt: r.classified_at as number,
	provider: r.provider as Disposition["provider"],
	model: (r.model as string | null) ?? null,
	mode: r.mode as Disposition["mode"],
	action: r.action as Disposition["action"],
	reasons: parse<string[]>(r.reasons) ?? [],
	answers: parse<Record<string, number>>(r.answers) ?? {},
	idleMinutes: r.idle_minutes as number,
	sentChars: r.sent_chars as number,
	redactions: r.redactions as number,
	inputTokens: (r.input_tokens as number | null) ?? null,
	costUsd: (r.cost_usd as number | null) ?? null,
	latencyMs: (r.latency_ms as number | null) ?? null,
	error: (r.error as string | null) ?? null,
	feedback: (r.feedback as Disposition["feedback"]) ?? null,
	correctedAction: (r.corrected_action as Disposition["correctedAction"]) ?? null,
});

function putDisposition(c: Db, d: DispositionWrite): void {
	c.run(
		`INSERT INTO thread_dispositions (server, thread_id, message_hash, bank_version, classified_at, provider, model, mode, action,
						reasons, answers, idle_minutes, sent_chars, redactions, input_tokens, cost_usd, latency_ms, error)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (server, thread_id, message_hash, bank_version) DO UPDATE SET classified_at = excluded.classified_at,
						provider = excluded.provider, model = excluded.model, mode = excluded.mode, action = excluded.action,
						reasons = excluded.reasons, answers = excluded.answers, idle_minutes = excluded.idle_minutes,
						sent_chars = excluded.sent_chars, redactions = excluded.redactions, input_tokens = excluded.input_tokens,
						cost_usd = excluded.cost_usd, latency_ms = excluded.latency_ms, error = excluded.error`,
		...keyArgs(d),
		d.classifiedAt,
		d.provider,
		d.model,
		d.mode,
		d.action,
		JSON.stringify(d.reasons),
		JSON.stringify(d.answers),
		Math.floor(d.idleMinutes),
		d.sentChars,
		d.redactions,
		d.inputTokens,
		d.costUsd,
		d.latencyMs,
		d.error,
	);
}

function dispositionUsage(c: Db, since: number, providers: readonly string[]): { calls: number; usd: number } {
	if (!providers.length) return { calls: 0, usd: 0 };
	const r = required(
		c.one(
			`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM thread_dispositions
					WHERE classified_at >= ? AND provider IN (${providers.map(() => "?").join(",")})`,
			since,
			...providers,
		),
		"disposition usage",
	);
	return { calls: r.n as number, usd: r.usd as number };
}

function dispositionSpend(
	c: Db,
	since: number,
	providers: readonly string[],
): ReturnType<Store["dispositions"]["spend"]> {
	if (!providers.length) return [];
	return c
		.all(
			`SELECT thread_id, classified_at, COALESCE(cost_usd, 0) AS usd FROM thread_dispositions
					WHERE classified_at >= ? AND provider IN (${providers.map(() => "?").join(",")})`,
			since,
			...providers,
		)
		.map((r) => ({ threadId: r.thread_id as string, at: r.classified_at as number, usd: r.usd as number }));
}

export const makeDispositions = (c: Db): Store["dispositions"] => ({
	get: (k) => {
		const r = c.one(`SELECT * FROM thread_dispositions WHERE ${KEY_WHERE}`, ...keyArgs(k));
		return r ? toDisposition(r) : undefined;
	},
	put: (d) => putDisposition(c, d),
	redecide(k, o) {
		c.run(
			`UPDATE thread_dispositions SET action = ?, reasons = ?, idle_minutes = ?, mode = ? WHERE ${KEY_WHERE} AND action != 'unknown'`,
			o.action,
			JSON.stringify(o.reasons),
			Math.floor(o.idleMinutes),
			o.mode,
			...keyArgs(k),
		);
	},
	usage: (since, providers) => dispositionUsage(c, since, providers),
	spend: (since, providers) => dispositionSpend(c, since, providers),
	feedback: (k, feedback, corrected) =>
		c.run(
			`UPDATE thread_dispositions SET feedback = ?, corrected_action = ? WHERE ${KEY_WHERE}`,
			feedback,
			corrected ?? null,
			...keyArgs(k),
		).changes > 0,
	prune: (before) =>
		c.run("DELETE FROM thread_dispositions WHERE classified_at < ? AND feedback IS NULL", before).changes,
});

// ---- the Steward's token usage per wake ----------------------------------------------------------------

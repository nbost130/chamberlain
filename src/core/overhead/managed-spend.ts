/**
 * What the sessions of the managed threads spent, from the LifeOS database: `sessions.metadata->>'t3_thread_id'` is the T3 thread a Claude session
 * ran for, `otel_api_requests` its requests. One read-only SELECT per batch of thread ids, through the same `lifeos-axi query --sql` door as
 * fleet-spend.ts (its row limit is 200, so a batch is small enough to answer in one page).
 *
 * A thread with a session row comes back as a row even when it spent nothing in the window: that is MAPPED. A thread with no session row comes back
 * as nothing, and the join (managed.ts) counts it unmapped. Experiments (`excludeProjects`, `excludeLabels`) keep their session row, so the thread
 * stays mapped, but their requests are not summed.
 *
 * An id that is not plain text (letters, digits and `: . _ % -`) is never put in a statement; it simply cannot be looked up, so it stays unmapped.
 * A failing batch rejects the whole read: a coverage computed over some batches would be a made-up number.
 */
import type { OverheadConfig } from "./config.ts";
import { type RunQuery, runQuery } from "./fleet-spend.ts";
import type { ThreadSpend } from "./managed.ts";
import { excludedSql, quoted, spanSql } from "./sql.ts";

const BATCH = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._%-]{0,300}$/;

/** Pure: the SELECT for one batch of ids over [from, to): one row per (host, thread) with its spend in the window. */
export function managedSql(cfg: OverheadConfig, ids: readonly string[], from: number, to: number): string {
	const excluded = excludedSql(cfg);
	const keep = excluded ? ` AND NOT (${excluded})` : "";
	return [
		"SELECT 'mthread' AS k, s.host || ' ' || (s.metadata->>'t3_thread_id') AS name,",
		`coalesce(round(sum(o.cost_usd_micros) FILTER (WHERE ${spanSql(from, to)}${keep})), 0)::bigint AS micros`,
		"FROM sessions s LEFT JOIN otel_api_requests o ON o.session_id = s.id",
		`WHERE s.metadata->>'t3_thread_id' IN (${quoted(ids)}) GROUP BY 2`,
	].join(" ");
}

/** Pure: the rows of one batch's CSV answer, from lines of the form `mthread,host1 mcp:launch:abc,1234`. */
export function parseManaged(output: string): ThreadSpend[] {
	const out: ThreadSpend[] = [];
	for (const line of output.split("\n")) {
		const m = /^mthread,([A-Za-z0-9._-]+) ([^,\s]+),(-?\d+)$/.exec(line.trim());
		if (m) out.push({ host: m[1] as string, id: m[2] as string, usd: Number(m[3]) / 1_000_000 });
	}
	return out;
}

/** The sessions' spend for these thread ids in [from, to). Rejects if any batch cannot be read. */
export async function managedSpend(
	cfg: OverheadConfig,
	ids: readonly string[],
	span: { from: number; to: number },
	run: RunQuery = runQuery,
): Promise<ThreadSpend[]> {
	const askable = ids.filter((i) => SAFE_ID.test(i));
	const rows: ThreadSpend[] = [];
	for (let i = 0; i < askable.length; i += BATCH) {
		const sql = managedSql(cfg, askable.slice(i, i + BATCH), span.from, span.to);
		rows.push(...parseManaged(await run(cfg.fleet.command, ["query", "--sql", sql, "--limit", "200"])));
	}
	return rows;
}

/**
 * Experiments in Chamberlain's OWN spend. The fleet total already leaves out the sessions of `excludeProjects` / `excludeLabels` (fleet-spend.ts);
 * the numerator must leave out the same things, or a Steward or classifier call made for an experiment counts as overhead against a fleet that
 * does not contain it. Two lookups, both read-only and through the same door as the rest (`lifeos-axi query --sql`):
 * - a Steward usage row belongs to the Claude session it was read from, so a row whose session is an experiment is dropped from every window;
 * - a classifier call belongs to the thread it classified, so its cost is taken off when a session that ran for that thread is an experiment.
 * An id that cannot be looked up stays in the figures. If the lookup FAILS the money figures are unverified, and unverified is "unavailable":
 * a number that may still contain experiments never triggers anything.
 */
import { errClass } from "../obs/fields.ts";
import type { WakeUsage } from "../store/store-records.ts";
import type { OverheadConfig } from "./config.ts";
import { type RunQuery, runQuery } from "./fleet-spend.ts";
import { BATCH, excludedSql, quoted, SAFE_ID } from "./sql.ts";

export type ClassifierSpend = { threadId: string; at: number; usd: number };
export type Experiments = { sessions: ReadonlySet<string>; threads: ReadonlySet<string> };

const NO_EXPERIMENTS: Experiments = { sessions: new Set(), threads: new Set() };

/** Whether any experiment can be told apart: something is excluded, and LifeOS is the source that knows sessions. */
export const exclusionConfigured = (
	cfg: Pick<OverheadConfig, "excludeProjects" | "excludeLabels" | "fleet">,
): boolean => cfg.fleet.source !== "off" && excludedSql(cfg) !== "";

/** Pure: the SELECT that names which of these ids belong to an experiment, by Claude session id or by the T3 thread id a session ran for. */
export function experimentsSql(cfg: OverheadConfig, kind: "session" | "thread", ids: readonly string[]): string {
	const key = kind === "session" ? "s.id" : "s.metadata->>'t3_thread_id'";
	return `SELECT DISTINCT 'x${kind}' AS k, ${key} AS name, 0::bigint AS micros FROM sessions s WHERE ${key} IN (${quoted(ids)}) AND (${excludedSql(cfg)})`;
}

/** Pure: the ids named by one answer, from lines of the form `xthread,mcp:launch:abc,0`. */
export function parseExperiments(output: string): { sessions: string[]; threads: string[] } {
	const out = { sessions: [] as string[], threads: [] as string[] };
	for (const line of output.split("\n")) {
		const m = /^x(session|thread),([^,\s]+),-?\d+$/.exec(line.trim());
		if (m) out[m[1] === "session" ? "sessions" : "threads"].push(m[2] as string);
	}
	return out;
}

/** Which of the ids are experiments. Rejects if any batch cannot be read. */
async function experimentsAmong(
	cfg: OverheadConfig,
	ids: { sessions: readonly string[]; threads: readonly string[] },
	run: RunQuery = runQuery,
): Promise<Experiments> {
	const sessions = new Set<string>();
	const threads = new Set<string>();
	for (const kind of ["session", "thread"] as const) {
		const askable = [...new Set(ids[`${kind}s`])].filter((i) => SAFE_ID.test(i));
		for (let i = 0; i < askable.length; i += BATCH) {
			const sql = experimentsSql(cfg, kind, askable.slice(i, i + BATCH));
			const found = parseExperiments(await run(cfg.fleet.command, ["query", "--sql", sql, "--limit", "200"]));
			for (const s of found.sessions) sessions.add(s);
			for (const t of found.threads) threads.add(t);
		}
	}
	return { sessions, threads };
}

export type ExperimentRead = { experiments: Experiments; unverified: boolean };

/** The experiments among Chamberlain's own spend, or `unverified` when they cannot be told (a failed lookup is noted by its class only). */
export async function readExperiments(
	d: { cfg: OverheadConfig; query?: RunQuery },
	own: { usage: readonly WakeUsage[]; classifier: readonly ClassifierSpend[] },
	unavailable: string[],
): Promise<ExperimentRead> {
	if (!exclusionConfigured(d.cfg)) return { experiments: NO_EXPERIMENTS, unverified: false };
	try {
		const ids = { sessions: own.usage.map((r) => r.session), threads: own.classifier.map((r) => r.threadId) };
		return { experiments: await experimentsAmong(d.cfg, ids, d.query), unverified: false };
	} catch (e) {
		unavailable.push(
			`experiment exclusion: unavailable (${errClass(e)}), so Steward and classifier spend and the no-op rate are not judged`,
		);
		return { experiments: NO_EXPERIMENTS, unverified: true };
	}
}

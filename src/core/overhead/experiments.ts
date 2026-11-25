/**
 * Experiments in Chamberlain's OWN spend. The fleet total already leaves out the sessions of `excludeProjects` / `excludeLabels` (fleet-spend.ts);
 * the numerator must leave out the same things, or a Steward or classifier call made for an experiment counts as overhead against a fleet that
 * does not contain it. Two lookups, both read-only and through the same door as the rest (`lifeos-axi query --sql`):
 * - a Steward usage row with a native telemetry session is dropped from every window when that session belongs to an experiment;
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

export const usageTelemetrySession = (r: WakeUsage): string | undefined =>
	r.source === "turn record" ? r.nativeSession : r.session;

const NO_EXPERIMENTS: Experiments = { sessions: new Set(), threads: new Set() };

/** Whether the operator excluded anything. When so, the exclusion must be applied to every figure it touches, or those figures are unavailable. */
export const exclusionConfigured = (cfg: Pick<OverheadConfig, "excludeProjects" | "excludeLabels">): boolean =>
	excludedSql(cfg) !== "";

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
		const all = [...new Set(ids[`${kind}s`])];
		const askable = all.filter((i) => SAFE_ID.test(i));
		// An id that cannot be put in a statement cannot be told apart from an experiment's: the exclusion cannot be applied.
		if (askable.length < all.length) throw Error(`a ${kind} id cannot be looked up`);
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
	if (d.cfg.fleet.source === "off") {
		// LifeOS is the only source that knows sessions: with it off the exclusion cannot be applied, and an unapplied exclusion is never skipped.
		unavailable.push(
			'experiment exclusion: overhead.fleet.source is "off", so excludeProjects/excludeLabels cannot be applied and Steward and classifier spend and the no-op rate are not judged',
		);
		return { experiments: NO_EXPERIMENTS, unverified: true };
	}
	try {
		const sessions = own.usage.map(usageTelemetrySession);
		if (!sessions.every((s): s is string => s !== undefined)) throw Error("a turn has no native telemetry session");
		const ids = { sessions, threads: own.classifier.map((r) => r.threadId) };
		return { experiments: await experimentsAmong(d.cfg, ids, d.query), unverified: false };
	} catch (e) {
		unavailable.push(
			`experiment exclusion: unavailable (${errClass(e)}), so Steward and classifier spend and the no-op rate are not judged`,
		);
		return { experiments: NO_EXPERIMENTS, unverified: true };
	}
}

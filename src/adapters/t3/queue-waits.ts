/**
 * How long wakes sat before the Steward started on them, and how long its turns ran. Read-only: it reads the daemon's
 * event log (the `events` table of chamberlain.db, with SQL) and T3's state database and writes nothing.
 *
 *   bun src/adapters/t3/queue-waits.ts [--hours N] [--json] [--store FILE] [--db FILE] [--steward THREAD_ID]
 *
 * Where each number comes from:
 * - When a wake was created: the delivered event in the event log carries `queuedAt` (and `kind`, `thread`) since this
 *   tool was added. Older records carry none, but the delivery ID of a thread wake or a sweep ends in the millisecond
 *   it was made, so that is read from the ID (shown as "from the delivery ID"). Anything else, such as an answer wake
 *   before `queuedAt` was recorded, has no creation time and is counted as not recorded, never guessed.
 * - When the Steward started on it: T3's run for that wake. A run is matched to a wake by time alone: the run was
 *   requested in the seconds before the delivered record was written. The run table has no link back to the wake.
 *   A wake with no such run is reported as unmatched.
 * - Turn length: the Steward's runs with both a start and a completion, whatever started them.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { CONF, STATE } from "../../core/config.ts";
import { thread } from "../../core/layout.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { dbPath as storeDbPath } from "../../core/store.ts";
import { t3StateDbPath } from "./settings.ts";

export type Wake = {
	deliveryId: string;
	kind: string;
	thread?: string;
	createdAt?: number;
	createdFrom?: "recorded" | "delivery-id";
	postedAt: number;
};
export type Run = { runId: string; requestedAt: number; startedAt?: number; completedAt?: number };
export type Stat = { n: number; p50: number; p90: number; max: number };
export type Worst = { deliveryId: string; kind: string; thread?: string; createdAt: number; waitMs: number };
export type Report = {
	hours: number;
	since: string;
	until: string;
	wakes: {
		posted: number;
		matched: number;
		unmatched: number;
		noCreationTime: number;
		createdFromId: number;
		notStarted: number;
	};
	totalWait: Stat | undefined;
	heldWait: Stat | undefined;
	t3Wait: Stat | undefined;
	turns: Stat | undefined;
	worst: Worst[];
	notes: string[];
};

/** Nearest-rank percentile of an ascending list. */
export function pct(sorted: number[], p: number): number {
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
export function stat(values: number[]): Stat | undefined {
	if (!values.length) return undefined;
	const v = [...values].sort((a, b) => a - b);
	return { n: v.length, p50: pct(v, 0.5), p90: pct(v, 0.9), max: v[v.length - 1]! };
}

/** The kind and creation time a delivery ID itself records, for wakes logged before `queuedAt` existed. */
export function fromDeliveryId(id: string): { kind: string; thread?: string; createdAt?: number } {
	const sweep = id.match(/^sweep:(\d{13})$/);
	if (sweep) return { kind: "sweep", createdAt: Number(sweep[1]) };
	const t = id.match(/^(.+?):(input|waiting|ended|failed):(?:.*:)?(\d{13})$/);
	if (t)
		return {
			kind: t[2] === "ended" ? "turn_ended" : t[2] === "failed" ? "failed" : "needs_input",
			thread: t[1],
			createdAt: Number(t[3]),
		};
	if (id.startsWith("answer:")) return { kind: "answer" };
	if (id.startsWith("digest:")) return { kind: "digest" };
	return { kind: "unknown" };
}

export type Delivered = {
	t: string;
	event: string;
	deliveryId: string;
	http?: number;
	queuedAt?: number;
	kind?: string;
	thread?: string;
	members?: { deliveryId: string; queuedAt?: number; kind?: string; thread?: string }[];
};

/**
 * One wake per accepted post, or per member of an accepted digest. A wake posted twice (the documented crash window) is
 * counted once, at its first post. Posts of /compact are not wakes.
 */
export function wakesFrom(events: Delivered[], sinceMs: number): Wake[] {
	const seen = new Set<string>();
	const out: Wake[] = [];
	for (const e of events) {
		if (e.event !== "delivered" || typeof e.http !== "number" || e.http >= 300 || e.deliveryId.startsWith("compact:"))
			continue;
		const postedAt = Date.parse(e.t);
		if (!Number.isFinite(postedAt) || postedAt < sinceMs) continue;
		for (const m of e.members ?? [{ deliveryId: e.deliveryId, queuedAt: e.queuedAt, kind: e.kind, thread: e.thread }]) {
			if (seen.has(m.deliveryId)) continue;
			seen.add(m.deliveryId);
			const id = fromDeliveryId(m.deliveryId);
			const recorded = typeof m.queuedAt === "number";
			out.push({
				deliveryId: m.deliveryId,
				kind: m.kind ?? id.kind,
				thread: m.thread ?? id.thread,
				postedAt,
				...(recorded
					? { createdAt: m.queuedAt, createdFrom: "recorded" as const }
					: id.createdAt !== undefined
						? { createdAt: id.createdAt, createdFrom: "delivery-id" as const }
						: {}),
			});
		}
	}
	return out;
}

/** A run is requested a moment before the webhook's answer is logged. */
const MATCH_BEFORE_MS = 20_000,
	MATCH_AFTER_MS = 2_000;

export function analyze(wakes: Wake[], runs: Run[], hours: number, nowMs: number): Report {
	const sinceMs = nowMs - hours * 3600_000;
	// One run per post: a digest's members share one.
	const posts = [...new Set(wakes.map((w) => w.postedAt))].sort((a, b) => a - b);
	const taken = new Set<string>();
	const runOf = new Map<number, Run>();
	for (const p of posts) {
		const run = [...runs]
			.sort((a, b) => a.requestedAt - b.requestedAt)
			.find((r) => !taken.has(r.runId) && r.requestedAt >= p - MATCH_BEFORE_MS && r.requestedAt <= p + MATCH_AFTER_MS);
		if (run) {
			taken.add(run.runId);
			runOf.set(p, run);
		}
	}
	const total: number[] = [],
		held: number[] = [],
		t3: number[] = [],
		worst: Worst[] = [];
	let matched = 0,
		noCreationTime = 0,
		createdFromId = 0,
		notStarted = 0;
	for (const w of wakes) {
		if (w.createdAt === undefined) noCreationTime++;
		if (w.createdFrom === "delivery-id") createdFromId++;
		const run = runOf.get(w.postedAt);
		if (!run) continue;
		matched++;
		if (run.startedAt === undefined) {
			notStarted++;
			continue;
		}
		t3.push(Math.max(0, run.startedAt - run.requestedAt));
		if (w.createdAt === undefined) continue;
		held.push(Math.max(0, run.requestedAt - w.createdAt));
		const waitMs = Math.max(0, run.startedAt - w.createdAt);
		total.push(waitMs);
		worst.push({ deliveryId: w.deliveryId, kind: w.kind, thread: w.thread, createdAt: w.createdAt, waitMs });
	}
	const turns = runs
		.filter((r) => r.startedAt !== undefined && r.completedAt !== undefined && r.completedAt >= r.startedAt)
		.map((r) => r.completedAt! - r.startedAt!);
	const notes: string[] = [];
	if (!wakes.length) notes.push("No accepted wake posts in the event log for this window.");
	if (noCreationTime)
		notes.push(
			`${noCreationTime} wake${noCreationTime === 1 ? "" : "s"} have no creation time in the log (answer wakes logged before queuedAt was recorded), so their total and held waits are not measured; their T3 queue wait is.`,
		);
	if (createdFromId)
		notes.push(
			`${createdFromId} wake${createdFromId === 1 ? "" : "s"} took their creation time from the millisecond in their delivery ID, as no queuedAt was recorded.`,
		);
	if (matched < wakes.length)
		notes.push(
			`${wakes.length - matched} wake${wakes.length - matched === 1 ? "" : "s"} matched no Steward run (still queued, a different thread, or the run is outside the window); not counted in any wait.`,
		);
	if (notStarted)
		notes.push(`${notStarted} matched run${notStarted === 1 ? "" : "s"} had not started yet; not counted in any wait.`);
	notes.push(
		"Runs are matched to wakes by time only (T3's run table does not name the wake): a run requested within 20s before the post was logged.",
	);
	return {
		hours,
		since: new Date(sinceMs).toISOString(),
		until: new Date(nowMs).toISOString(),
		wakes: {
			posted: wakes.length,
			matched,
			unmatched: wakes.length - matched,
			noCreationTime,
			createdFromId,
			notStarted,
		},
		totalWait: stat(total),
		heldWait: stat(held),
		t3Wait: stat(t3),
		turns: stat(turns),
		worst: worst.sort((a, b) => b.waitMs - a.waitMs).slice(0, 5),
		notes,
	};
}

/** The Steward's runs since a time, read-only. A run that has not started or finished simply lacks those fields. */
export function readRuns(dbPath: string, threadId: string, sinceMs: number): Run[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(`select run_id, requested_at, completed_at, json_extract(payload_json, '$.startedAt') as started_at
			from orchestration_v2_projection_runs where thread_id = ? and requested_at >= ? order by requested_at`)
			.all(threadId, new Date(sinceMs - 60_000).toISOString()) as {
			run_id: string;
			requested_at: string;
			completed_at: string | null;
			started_at: string | null;
		}[];
		const ms = (s: string | null) => {
			const n = s ? Date.parse(s) : NaN;
			return Number.isFinite(n) ? n : undefined;
		};
		return rows.map((r) => ({
			runId: r.run_id,
			requestedAt: Date.parse(r.requested_at),
			startedAt: ms(r.started_at),
			completedAt: ms(r.completed_at),
		}));
	} finally {
		db.close();
	}
}

const dur = (ms: number) =>
	ms < 90_000
		? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
		: ms < 90 * 60_000
			? `${(ms / 60_000).toFixed(1)}m`
			: `${(ms / 3600_000).toFixed(1)}h`;
const line = (label: string, s: Stat | undefined) =>
	`${label.padEnd(34)} ${s ? `n=${s.n}  p50 ${dur(s.p50)}  p90 ${dur(s.p90)}  max ${dur(s.max)}` : "no data"}`;

export function format(r: Report): string {
	return [
		`Queue waits, last ${r.hours}h (${r.since} to ${r.until})`,
		`Wakes posted: ${r.wakes.posted}; matched to a Steward run: ${r.wakes.matched}`,
		"",
		line("Wait before the Steward started", r.totalWait),
		line("  held by chamberlain (digest hold)", r.heldWait),
		line("  queued in T3 behind other turns", r.t3Wait),
		line("Steward turn length", r.turns),
		"",
		"5 worst waits:",
		...(r.worst.length
			? r.worst.map(
					(w, i) =>
						`  ${i + 1}. ${dur(w.waitMs)}  ${w.kind}  ${w.thread ?? "(no thread)"}  ${w.deliveryId}  created ${new Date(w.createdAt).toISOString()}`,
				)
			: ["  none measured"]),
		"",
		"Not measured / how to read:",
		...r.notes.map((n) => `  - ${n}`),
	].join("\n");
}

function arg(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[] = process.argv.slice(2)) {
	const hours = Number(arg(argv, "--hours") ?? 24);
	if (!Number.isFinite(hours) || hours <= 0) {
		console.error("--hours must be a positive number");
		process.exit(2);
	}
	const storeFile = arg(argv, "--store") ?? storeDbPath(STATE);
	const dbPath = arg(argv, "--db") ?? t3StateDbPath();
	let steward = arg(argv, "--steward");
	if (!steward) {
		steward = thread(CONF, "steward");
		if (!steward) {
			console.error("no Steward thread: pass --steward THREAD_ID");
			process.exit(2);
		}
	}
	if (!existsSync(storeFile)) {
		console.error(`database not found: ${storeFile}`);
		process.exit(2);
	}
	const now = Date.now();
	let runs: Run[];
	try {
		runs = readRuns(dbPath, steward, now - hours * 3600_000);
	} catch (e) {
		console.error(`cannot read T3 state database ${dbPath}: ${String(e).slice(0, 160)}`);
		process.exit(2);
	}
	const store = openStore(storeFile);
	const delivered = store.events.query({
		events: ["delivered"],
		since: new Date(now - hours * 3600_000).toISOString(),
	}) as Delivered[];
	store.close();
	const report = analyze(wakesFrom(delivered, now - hours * 3600_000), runs, hours, now);
	console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : format(report));
}

if (import.meta.main) main();

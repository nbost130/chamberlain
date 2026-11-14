/** The numbers behind `chamberlain debug queue-waits` (./queue-waits.ts): wakes read from the event log, runs from T3's state database, and how each wake's wait is measured. */
import { Database } from "bun:sqlite";

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
type Worst = { deliveryId: string; kind: string; thread?: string; createdAt: number; waitMs: number };
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
	const v = sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
	if (v === undefined) throw Error("pct: the list is empty");
	return v;
}
export function stat(values: number[]): Stat | undefined {
	if (!values.length) return undefined;
	const v = [...values].sort((a, b) => a - b);
	return { n: v.length, p50: pct(v, 0.5), p90: pct(v, 0.9), max: pct(v, 1) };
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

type Member = NonNullable<Delivered["members"]>[number];

/** A delivered event that is an accepted wake post: not a failure and not a post of /compact. */
const isAcceptedPost = (e: Delivered): boolean =>
	e.event === "delivered" && typeof e.http === "number" && !(e.http >= 300) && !e.deliveryId.startsWith("compact:");

/** The wakes one accepted post carries: its digest's members, or the post itself. */
const membersOf = (e: Delivered): Member[] =>
	e.members ?? [{ deliveryId: e.deliveryId, queuedAt: e.queuedAt, kind: e.kind, thread: e.thread }];

/** The wake a post's member is: its own recorded creation time, else the one its delivery ID carries, else none. */
function wakeOf(m: Member, postedAt: number): Wake {
	const id = fromDeliveryId(m.deliveryId);
	return {
		deliveryId: m.deliveryId,
		kind: m.kind ?? id.kind,
		thread: m.thread ?? id.thread,
		postedAt,
		...(typeof m.queuedAt === "number"
			? { createdAt: m.queuedAt, createdFrom: "recorded" as const }
			: id.createdAt !== undefined
				? { createdAt: id.createdAt, createdFrom: "delivery-id" as const }
				: {}),
	};
}

/**
 * One wake per accepted post, or per member of an accepted digest. A wake posted twice (the documented crash window) is
 * counted once, at its first post. Posts of /compact are not wakes.
 */
export function wakesFrom(events: Delivered[], sinceMs: number): Wake[] {
	const seen = new Set<string>();
	const out: Wake[] = [];
	for (const e of events) {
		if (!isAcceptedPost(e)) continue;
		const postedAt = Date.parse(e.t);
		if (!Number.isFinite(postedAt) || postedAt < sinceMs) continue;
		for (const m of membersOf(e)) {
			if (seen.has(m.deliveryId)) continue;
			seen.add(m.deliveryId);
			out.push(wakeOf(m, postedAt));
		}
	}
	return out;
}

/** A run is requested a moment before the webhook's answer is logged. */
const MATCH_BEFORE_MS = 20_000,
	MATCH_AFTER_MS = 2_000;

/** Each post's run: the earliest-requested run not already taken that was requested in the window around the post. */
function matchRuns(wakes: Wake[], runs: Run[]): Map<number, Run> {
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
	return runOf;
}

type Waits = {
	total: number[];
	held: number[];
	t3: number[];
	worst: Worst[];
	matched: number;
	noCreationTime: number;
	createdFromId: number;
	notStarted: number;
};

/** The wait of each wake against the run its post matched, and the counts of what could not be measured. */
function measureWaits(wakes: Wake[], runOf: Map<number, Run>): Waits {
	const w: Waits = {
		total: [],
		held: [],
		t3: [],
		worst: [],
		matched: 0,
		noCreationTime: 0,
		createdFromId: 0,
		notStarted: 0,
	};
	for (const wake of wakes) {
		if (wake.createdAt === undefined) w.noCreationTime++;
		if (wake.createdFrom === "delivery-id") w.createdFromId++;
		const run = runOf.get(wake.postedAt);
		if (!run) continue;
		w.matched++;
		if (run.startedAt === undefined) {
			w.notStarted++;
			continue;
		}
		w.t3.push(Math.max(0, run.startedAt - run.requestedAt));
		if (wake.createdAt === undefined) continue;
		w.held.push(Math.max(0, run.requestedAt - wake.createdAt));
		const waitMs = Math.max(0, run.startedAt - wake.createdAt);
		w.total.push(waitMs);
		w.worst.push({
			deliveryId: wake.deliveryId,
			kind: wake.kind,
			thread: wake.thread,
			createdAt: wake.createdAt,
			waitMs,
		});
	}
	return w;
}

/** The lengths of the runs with both a start and a completion, whatever started them. */
const turnLengths = (runs: Run[]): number[] =>
	runs.flatMap((r) =>
		r.startedAt !== undefined && r.completedAt !== undefined && r.completedAt >= r.startedAt
			? [r.completedAt - r.startedAt]
			: [],
	);

const s = (n: number) => (n === 1 ? "" : "s");

/** What the numbers leave out, in words. */
function notesFor(wakeCount: number, w: Waits): string[] {
	const notes: string[] = [];
	if (!wakeCount) notes.push("No accepted wake posts in the event log for this window.");
	if (w.noCreationTime)
		notes.push(
			`${w.noCreationTime} wake${s(w.noCreationTime)} have no creation time in the log (answer wakes logged before queuedAt was recorded), so their total and held waits are not measured; their T3 queue wait is.`,
		);
	if (w.createdFromId)
		notes.push(
			`${w.createdFromId} wake${s(w.createdFromId)} took their creation time from the millisecond in their delivery ID, as no queuedAt was recorded.`,
		);
	if (w.matched < wakeCount)
		notes.push(
			`${wakeCount - w.matched} wake${s(wakeCount - w.matched)} matched no Steward run (still queued, a different thread, or the run is outside the window); not counted in any wait.`,
		);
	if (w.notStarted)
		notes.push(`${w.notStarted} matched run${s(w.notStarted)} had not started yet; not counted in any wait.`);
	notes.push(
		"Runs are matched to wakes by time only (T3's run table does not name the wake): a run requested within 20s before the post was logged.",
	);
	return notes;
}

export function analyze(wakes: Wake[], runs: Run[], hours: number, nowMs: number): Report {
	const sinceMs = nowMs - hours * 3600_000;
	const w = measureWaits(wakes, matchRuns(wakes, runs));
	return {
		hours,
		since: new Date(sinceMs).toISOString(),
		until: new Date(nowMs).toISOString(),
		wakes: {
			posted: wakes.length,
			matched: w.matched,
			unmatched: wakes.length - w.matched,
			noCreationTime: w.noCreationTime,
			createdFromId: w.createdFromId,
			notStarted: w.notStarted,
		},
		totalWait: stat(w.total),
		heldWait: stat(w.held),
		t3Wait: stat(w.t3),
		turns: stat(turnLengths(runs)),
		worst: w.worst.sort((a, b) => b.waitMs - a.waitMs).slice(0, 5),
		notes: notesFor(wakes.length, w),
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

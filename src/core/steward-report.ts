/** The token metric's report: per-kind statistics, the trend across a session, and the text of `usage`. */

import { isWake, totalTokens } from "./steward-tokens.ts";
import type { Store } from "./store.ts";
import type { WakeUsage } from "./store-records.ts";

/** The nearest-rank percentile of a list (p in 0..100); undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
	if (!values.length) return undefined;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

type KindStats = {
	kind: string;
	wakes: number;
	tokensP50?: number;
	tokensP90?: number;
	requestsP50?: number;
	requestsP90?: number;
	contextStartP50?: number;
};
export type SessionTrend = {
	session: string;
	firstAt: number;
	wakes: number;
	contextFirst?: number;
	contextLast?: number;
	contextPeak?: number;
	/** Least-squares slope of context at wake start, per wake, since the session's last compaction. */
	growthPerWake?: number;
};
export type WindowStats = {
	label: string;
	since: number;
	segments: number;
	requests: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	kinds: KindStats[];
	fullSweep?: KindStats;
	sessions: SessionTrend[];
};

function kindStats(kind: string, rows: WakeUsage[]): KindStats {
	const tokens = rows.map(totalTokens),
		req = rows.map((r) => r.requests),
		ctx = rows.flatMap((r) => (r.contextStart === undefined ? [] : [r.contextStart]));
	return {
		kind,
		wakes: rows.length,
		tokensP50: percentile(tokens, 50),
		tokensP90: percentile(tokens, 90),
		requestsP50: percentile(req, 50),
		requestsP90: percentile(req, 90),
		contextStartP50: percentile(ctx, 50),
	};
}

function slope(ys: number[]): number | undefined {
	if (ys.length < 2) return undefined;
	const n = ys.length,
		mx = (n - 1) / 2,
		my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0,
		den = 0;
	ys.forEach((y, x) => {
		num += (x - mx) * (y - my);
		den += (x - mx) ** 2;
	});
	return num / den;
}

/** One session's trend: its first wake, its context at the first and last wake, its peak, and its growth since the last compaction. */
function trendOf(session: string, rs: WakeUsage[]): SessionTrend {
	rs.sort((a, b) => a.startedAt - b.startedAt);
	const first = rs[0];
	if (!first) throw Error("sessionTrends: a session group is never empty");
	const ctx = rs.filter((r) => r.contextStart !== undefined);
	// The growth since the last compaction: a compaction resets the context, so the slope is measured after it.
	const lastCompact = rs.findLastIndex((r) => r.compactions > 0 || r.kind === "compact");
	const since = rs
		.slice(lastCompact + 1)
		.flatMap((r) => (isWake(r.kind) && r.contextStart !== undefined ? [r.contextStart] : []));
	const peaks = rs.flatMap((r) => (r.contextPeak === undefined ? [] : [r.contextPeak]));
	return {
		session,
		firstAt: first.startedAt,
		wakes: rs.filter((r) => isWake(r.kind)).length,
		contextFirst: ctx[0]?.contextStart,
		contextLast: ctx.at(-1)?.contextStart,
		contextPeak: peaks.length ? Math.max(...peaks) : undefined,
		growthPerWake: slope(since),
	};
}

export function sessionTrends(rows: WakeUsage[]): SessionTrend[] {
	const by = new Map<string, WakeUsage[]>();
	for (const r of rows) by.set(r.session, [...(by.get(r.session) ?? []), r]);
	return [...by.entries()].map(([session, rs]) => trendOf(session, rs)).sort((a, b) => a.firstAt - b.firstAt);
}

export function windowStats(rows: WakeUsage[], label: string, since: number): WindowStats {
	const inWin = rows.filter((r) => r.startedAt >= since);
	const sum = (f: (r: WakeUsage) => number) => inWin.reduce((a, r) => a + f(r), 0);
	const kinds = new Map<string, WakeUsage[]>();
	for (const r of inWin) kinds.set(r.kind, [...(kinds.get(r.kind) ?? []), r]);
	const full = inWin.filter((r) => r.kind === "sweep" && r.variant === "full");
	return {
		label,
		since,
		segments: inWin.length,
		requests: sum((r) => r.requests),
		inputTokens: sum((r) => r.inputTokens),
		cacheReadInputTokens: sum((r) => r.cacheReadInputTokens),
		cacheCreationInputTokens: sum((r) => r.cacheCreationInputTokens),
		outputTokens: sum((r) => r.outputTokens),
		kinds: [...kinds.entries()].map(([k, rs]) => kindStats(k, rs)).sort((a, b) => b.wakes - a.wakes),
		...(full.length ? { fullSweep: kindStats("sweep (full)", full) } : {}),
		sessions: sessionTrends(inWin),
	};
}

const k = (n: number | undefined) =>
	n === undefined
		? "-"
		: n >= 1e6
			? `${(n / 1e6).toFixed(2)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: String(Math.round(n));

/** The report `chamberlain steward-health tokens` prints. Numbers only: no transcript text ever reaches it. */
export function formatUsage(windows: WindowStats[], o: { compactAt: number; now: number }): string {
	const out: string[] = [];
	for (const w of windows) {
		out.push(`Steward tokens, ${w.label} (since ${new Date(w.since).toISOString()})`);
		if (!w.segments) {
			out.push("  no measured turns in this window", "");
			continue;
		}
		out.push(
			`  ${w.segments} turns, ${w.requests} model requests; tokens: cache read ${k(w.cacheReadInputTokens)}, cache write ${k(w.cacheCreationInputTokens)}, input ${k(w.inputTokens)}, output ${k(w.outputTokens)}`,
			"  kind             turns  tokens p50  p90       requests p50  p90   context at start p50",
		);
		const row = (s: KindStats) =>
			`  ${s.kind.padEnd(16)} ${String(s.wakes).padStart(5)}  ${k(s.tokensP50).padStart(10)}  ${k(s.tokensP90).padEnd(8)}  ${String(s.requestsP50 ?? "-").padStart(12)}  ${String(s.requestsP90 ?? "-").padEnd(5)} ${k(s.contextStartP50).padStart(10)}`;
		for (const s of w.kinds) out.push(row(s));
		out.push(
			w.fullSweep
				? `  A full sweep wake: ${k(w.fullSweep.tokensP50)} tokens (p50), ${k(w.fullSweep.tokensP90)} (p90), ${w.fullSweep.requestsP50} requests (p50), over ${w.fullSweep.wakes}`
				: "  A full sweep wake: none in this window",
			"  Context trend (context at wake start; growth is per wake since the last compaction):",
		);
		for (const s of w.sessions.slice(-8))
			out.push(
				`    ${s.session.slice(0, 8)}  from ${new Date(s.firstAt).toISOString().slice(0, 16)}Z  ${String(s.wakes).padStart(3)} wakes  ${k(s.contextFirst)} -> ${k(s.contextLast)}  peak ${k(s.contextPeak)}  growth ${s.growthPerWake === undefined ? "-" : `${k(s.growthPerWake)}/wake`}`,
			);
		out.push("");
	}
	const latest = windows[0]?.sessions.at(-1);
	if (latest?.contextLast !== undefined && latest.growthPerWake !== undefined && latest.growthPerWake > 0) {
		const left = Math.max(0, Math.ceil((o.compactAt - latest.contextLast) / latest.growthPerWake));
		out.push(
			`Current session ${latest.session.slice(0, 8)}: context ${k(latest.contextLast)} at its latest wake, growing ${k(latest.growthPerWake)} per wake; about ${left} wakes to the ${k(o.compactAt)} compaction line.`,
		);
	}
	return out.join("\n").trimEnd();
}

/** The report's windows: the last 24 hours and the last 7 days. */
export function usageReport(
	store: Store,
	o: { now?: number; compactAt: number },
): { text: string; windows: WindowStats[] } {
	const now = o.now ?? Date.now();
	const rows = store.usage.list({ since: now - 7 * 24 * 3_600_000 });
	const windows = [
		windowStats(rows, "last 24 h", now - 24 * 3_600_000),
		windowStats(rows, "last 7 d", now - 7 * 24 * 3_600_000),
	];
	return { text: formatUsage(windows, { compactAt: o.compactAt, now }), windows };
}

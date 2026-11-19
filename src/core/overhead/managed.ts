/**
 * The managed overhead ratio: what Chamberlain's own work costs against what the threads it SUPERVISES cost.
 *
 * WHICH THREADS (the authoritative record). A thread is managed in a window when Chamberlain took action on it in that window, and its own database
 * says so in two places that together cover it:
 *  - the `fire` events of the event log: the watcher decided to wake the Steward about this thread (a turn ended, it needs input, it failed). They
 *    carry `threadId` and the `server` it runs on, so they say which host a thread belongs to. A `fire` with kind `compact` (or server `steward`) is
 *    the Steward's own thread being compacted, not a managed one.
 *  - the wake members of the outbox and the held store (`outbox_members` / `held_wakes`, `thread`): a wake or a report queued for the Steward
 *    naming the thread, such as the notes builders send. They carry no server.
 * Threads Chamberlain runs itself are not managed: the pinned Steward, Decisions and Desk threads, the butlers it launched and its investigators.
 * (The other tables name threads too, `items` with subject_kind `thread` and `thread_dispositions`, but they only add threads already in these two:
 * measured 2026-11-18, 14 of 18 thread items were already wake members, and dispositions are empty while the classifier is off.)
 *
 * WHICH SPEND. LifeOS records which T3 thread a Claude session ran for (`sessions.metadata->>'t3_thread_id'`), and `otel_api_requests` its cost.
 * A managed thread is MAPPED when it has at least one such session; one with none is UNMAPPED, and its spend is unknown, never $0. COVERAGE is
 * mapped over managed. Below 100% the ratio is PARTIAL (its denominator is short, so it overstates), and below `minCoverage` it never triggers.
 *
 * This file is the pure join. managed-spend.ts reads the sessions' spend, collect.ts fetches the rest.
 */
import type { LogEvent } from "../store/store.ts";

/** A managed thread and, when a `fire` event named it, the server it runs on. */
export type ManagedThread = { id: string; server?: string };
/** One mapped thread's sessions on one host, and what they spent in the window (experiments excluded). */
export type ThreadSpend = { id: string; host: string; usd: number };

export type ManagedReport = {
	threads: number;
	mapped: number;
	unmapped: number;
	/** mapped / threads; undefined with no managed thread. */
	coverage?: number;
	/** What the mapped threads spent in the window. Never includes a guess for an unmapped one. */
	spendUsd: number;
	/** Managed and mapped threads by host: the server a `fire` named, else the host of the thread's sessions, else "unknown". */
	byHost: { host: string; managed: number; mapped: number }[];
};

type Member = { thread?: string; queuedAt: number };

/** The managed figures kept in state after each measurement, for the Decisions view. */
export type ManagedSummary = {
	status: "ok" | "not-configured" | "unavailable";
	threads?: number;
	mapped?: number;
	coverage?: number;
	ratio?: number;
	costPerThread?: number;
	/** The coverage below which the ratio is only reported. */
	minCoverage: number;
};

/** Pure: the threads managed in [from, to), minus those Chamberlain runs itself (`own`). A thread seen by both sources keeps the server a `fire` gave it. */
export function managedThreads(a: {
	events: readonly LogEvent[];
	members: readonly Member[];
	own: ReadonlySet<string>;
	from: number;
	to: number;
}): ManagedThread[] {
	const by = new Map<string, ManagedThread>();
	const within = (ms: number) => ms >= a.from && ms < a.to;
	for (const e of a.events) {
		const id = e.threadId;
		if (e.event !== "fire" || typeof id !== "string" || !id || e.kind === "compact" || e.server === "steward") continue;
		if (within(Date.parse(e.t)))
			by.set(id, { id, ...(typeof e.server === "string" && e.server ? { server: e.server } : {}) });
	}
	for (const m of a.members)
		if (m.thread && within(m.queuedAt) && !by.has(m.thread)) by.set(m.thread, { id: m.thread });
	return [...by.values()].filter((t) => !a.own.has(t.id));
}

/** Pure: the managed threads joined to the spend of their sessions. A thread with any row is mapped, whatever it spent; one with none is not. */
export function joinManaged(threads: readonly ManagedThread[], rows: readonly ThreadSpend[]): ManagedReport {
	const mappedHost = new Map<string, string>();
	let spendUsd = 0;
	const known = new Set(threads.map((t) => t.id));
	for (const r of rows) {
		if (!known.has(r.id)) continue;
		if (!mappedHost.has(r.id)) mappedHost.set(r.id, r.host);
		spendUsd += r.usd;
	}
	const hosts = new Map<string, { managed: number; mapped: number }>();
	for (const t of threads) {
		const host = t.server ?? mappedHost.get(t.id) ?? "unknown";
		const h = hosts.get(host) ?? { managed: 0, mapped: 0 };
		h.managed++;
		if (mappedHost.has(t.id)) h.mapped++;
		hosts.set(host, h);
	}
	const mapped = threads.filter((t) => mappedHost.has(t.id)).length;
	return {
		threads: threads.length,
		mapped,
		unmapped: threads.length - mapped,
		...(threads.length ? { coverage: mapped / threads.length } : {}),
		spendUsd,
		byHost: [...hosts.entries()].map(([host, v]) => ({ host, ...v })).sort((x, y) => y.managed - x.managed),
	};
}

/**
 * Pure: the ratio and the cost per managed thread, from the Chamberlain-caused spend. The ratio is undefined when that spend is unknown, when no
 * mapped thread spent anything (a division by nothing), or when the result is not a finite number. It is a PARTIAL ratio whenever coverage is
 * below 1: the report says so, and `managedCrossing` (metrics.ts) judges the coverage.
 */
export function managedFigures(
	causedUsd: number | undefined,
	r: ManagedReport,
): { ratio?: number; costPerThread?: number } {
	const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);
	if (!finite(causedUsd)) return {};
	const ratio = r.spendUsd > 0 ? causedUsd / r.spendUsd : undefined;
	const perThread = r.threads > 0 ? causedUsd / r.threads : undefined;
	return { ...(finite(ratio) ? { ratio } : {}), ...(finite(perThread) ? { costPerThread: perThread } : {}) };
}

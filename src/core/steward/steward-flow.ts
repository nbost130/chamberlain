/**
 * The flow report, `chamberlain steward-health flow`: day by day, where the Steward's turns come from and what they cost, and whether the
 * measures that cut them are working. Numbers only, from the token metric (steward_wake_usage) and the daemon's event log; no text of a
 * wake or a transcript reaches it.
 *
 * What each column answers:
 * - direct, notice, wakes: turns started by a thread messaging the Steward straight, by T3 itself (a watched PR, a delegated task's
 *   result), and by Chamberlain. Direct turns should fall as threads report with `chamberlain note`, which joins the next digest.
 * - notes, answers: reports and decision-queue answers held for a digest instead of sent as turns of their own.
 * - digests, items: digests sent and the wakes they carried; given up: held turn-end reports dropped because their thread moved on.
 * - reads/item: the Steward's reads of other threads per digest item, the verification a digest that says too little costs.
 * - ctx p50: the Steward's context at the start of a turn. Every request re-reads it, so it sets the price of every turn.
 */
import type { Store } from "../store/store.ts";
import type { WakeUsage } from "../store/store-records.ts";
import { percentile } from "./steward-report.ts";
import { isWake, totalTokens } from "./steward-tokens.ts";

const DAY_MS = 24 * 3_600_000;

export type FlowDay = {
	day: string;
	turns: { direct: number; notice: number; wakes: number; other: number };
	tokens: { direct: number; notice: number; wakes: number; other: number };
	notesHeld: number;
	answersHeld: number;
	digests: number;
	digestItems: number;
	givenUp: number;
	/** Thread reads per digest item, over digest turns measured with tool counts (migration 20); undefined when there are none. */
	readsPerItem?: number;
	contextP50?: number;
};

type Bucket = keyof FlowDay["turns"];
const bucketOf = (kind: string): Bucket =>
	kind === "message" ? "direct" : kind === "notice" ? "notice" : isWake(kind) ? "wakes" : "other";
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const emptyDay = (day: string): FlowDay => ({
	day,
	turns: { direct: 0, notice: 0, wakes: 0, other: 0 },
	tokens: { direct: 0, notice: 0, wakes: 0, other: 0 },
	notesHeld: 0,
	answersHeld: 0,
	digests: 0,
	digestItems: 0,
	givenUp: 0,
});

type Ev = { t: string; event: string; deliveryId?: unknown; members?: unknown };
const memberCount = (e: Ev) => (Array.isArray(e.members) ? e.members.length : 0);

/** Folds the daemon's events into the days: held notes and answers, digests composed and their size, reports given up. */
function addEvents(days: Map<string, FlowDay>, events: Ev[], itemsByDigest: Map<string, number>) {
	for (const e of events) {
		const d = days.get(e.t.slice(0, 10));
		if (!d) continue;
		const id = String(e.deliveryId ?? "");
		if (e.event === "deliver-held" && id.startsWith("note:")) d.notesHeld++;
		else if (e.event === "deliver-held" && id.startsWith("answer:")) d.answersHeld++;
		else if (e.event === "held-given-up") d.givenUp += memberCount(e);
		else if (e.event === "composed" && memberCount(e) > 1) {
			d.digests++;
			d.digestItems += memberCount(e);
			itemsByDigest.set(id, memberCount(e));
		}
	}
}

type Reads = Map<string, { reads: number; items: number }>;

/** A digest turn measured with tool counts adds its thread reads and its item count to its day. */
function addDigestReads(reads: Reads, day: string, r: WakeUsage, itemsByDigest: Map<string, number>) {
	const items = r.deliveryId ? itemsByDigest.get(r.deliveryId) : undefined;
	if (r.kind !== "digest" || !items || r.threadReads === undefined) return;
	const acc = reads.get(day) ?? { reads: 0, items: 0 };
	reads.set(day, { reads: acc.reads + r.threadReads, items: acc.items + items });
}

/** Folds the Steward's measured turns into the days: turns and tokens per source, context, and reads per digest item. */
function addTurns(days: Map<string, FlowDay>, rows: WakeUsage[], itemsByDigest: Map<string, number>) {
	const ctx = new Map<string, number[]>();
	const reads: Reads = new Map();
	for (const r of rows) {
		const d = days.get(dayOf(r.startedAt));
		if (!d) continue;
		const b = bucketOf(r.kind);
		d.turns[b]++;
		d.tokens[b] += totalTokens(r);
		if (isWake(r.kind) && r.contextStart !== undefined) ctx.set(d.day, [...(ctx.get(d.day) ?? []), r.contextStart]);
		addDigestReads(reads, d.day, r, itemsByDigest);
	}
	for (const d of days.values()) {
		d.contextP50 = percentile(ctx.get(d.day) ?? [], 50);
		const rd = reads.get(d.day);
		if (rd?.items) d.readsPerItem = rd.reads / rd.items;
	}
}

/** The last `n` UTC days, oldest first, each with its flow. */
export function flowReport(store: Store, o: { days?: number; now?: number } = {}): FlowDay[] {
	const now = o.now ?? Date.now();
	const n = Math.max(1, o.days ?? 7);
	const start = Date.parse(`${dayOf(now - (n - 1) * DAY_MS)}T00:00:00Z`);
	const days = new Map<string, FlowDay>();
	for (let t = start; t <= now; t += DAY_MS) days.set(dayOf(t), emptyDay(dayOf(t)));
	const itemsByDigest = new Map<string, number>();
	const since = new Date(start).toISOString();
	addEvents(
		days,
		store.events.query({ since, events: ["deliver-held", "composed", "held-given-up"] }) as Ev[],
		itemsByDigest,
	);
	addTurns(days, store.usage.list({ since: start }), itemsByDigest);
	return [...days.values()];
}

const k = (n: number | undefined) =>
	n === undefined
		? "-"
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: String(Math.round(n));

/** The table `chamberlain steward-health flow` prints. */
export function formatFlow(days: FlowDay[]): string {
	const out = [
		"Steward turn flow by UTC day (turns, then tokens; see `chamberlain steward-health tokens` for per-kind cost)",
		"  day          direct  notice  wakes | tokens direct  notice   wakes | notes answers | digests items given-up reads/item | ctx p50",
	];
	for (const d of days)
		out.push(
			`  ${d.day}  ${String(d.turns.direct).padStart(6)}  ${String(d.turns.notice).padStart(6)}  ${String(d.turns.wakes).padStart(5)} | ${k(d.tokens.direct).padStart(13)}  ${k(d.tokens.notice).padStart(6)}  ${k(d.tokens.wakes).padStart(6)} | ${String(d.notesHeld).padStart(5)}  ${String(d.answersHeld).padStart(6)} | ${String(d.digests).padStart(7)}  ${String(d.digestItems).padStart(4)}  ${String(d.givenUp).padStart(8)}  ${(d.readsPerItem === undefined ? "-" : d.readsPerItem.toFixed(2)).padStart(10)} | ${k(d.contextP50).padStart(7)}`,
		);
	out.push(
		"",
		"Read it as: direct turns falling while notes rise means threads report through the digest; given-up items are stale reports the",
		"Steward never had to read; reads/item near 0 means it trusts the digest; ctx p50 sets the price of every request.",
	);
	return out.join("\n");
}

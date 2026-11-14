/**
 * What the Steward spends per wake, from its own Claude Code transcript. No model call: every assistant row of a transcript already carries
 * the API's `usage` object, so the history is exact and can be read back to the first Steward session.
 *
 * A transcript is split into SEGMENTS, one per turn-starting prompt: a wake (its `[chamberlain] <kind>:` or, before the rename,
 * `[t3-wake] <kind>:` header), the start prompt, a `/compact`, a T3 notice (a PR watch update, a delegated task's result) or any other message
 * (the principal's own, or one another thread sent). Everything after it until the next one belongs to it: background-task notifications, Stop
 * hook feedback and the skill body a slash command expands to are continuations, not new segments. Each segment sums the four usage fields
 * over its distinct model requests and records the context size at its first and last request.
 *
 * Nothing here keeps any text: a segment is its key, its kind and numbers. See docs/steward-health.md, "Tokens per wake".
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Transcript } from "./adapter.ts";
import type { Store, WakeUsage } from "./store.ts";

export type { WakeUsage } from "./store.ts";

/** The wake header every Chamberlain wake starts with; `t3-wake` is the name it had before. */
const WAKE_HEADER = /\[(?:chamberlain|t3-wake)\] ([a-z][a-z0-9_-]*):/;
/** The delivery id line deliver.ts appends as a wake's last line. */
const DELIVERY_ID = /delivery id: (\S+) \(the same id again is a repeat/;
/** How far into a prompt the wake header may sit: after the slash command's own preamble, before any quoted thread text. */
const HEADER_WITHIN = 2000;
/** Prompts that continue the turn in progress rather than start a new segment. */
const CONTINUATIONS = [
	/^<task-notification>/,
	/^Stop hook feedback:/,
	/^<local-command-/,
	/^This session is being continued from a previous conversation/,
	/^\[Request interrupted/,
];
/** Turns T3 itself starts in the thread: a watched pull request's update, a delegated task's result. */
const NOTICES = [/^Update on pull request #\d+/, /^Delegated task /];

export type Prompt = { kind: string; variant?: string; deliveryId?: string };

/**
 * What a turn-starting prompt is: a wake of some kind, `start`, `compact`, `notice` or `message`, or undefined when it continues the segment in
 * progress. Pure: the text is read here and never kept.
 */
export function classifyPrompt(text: string): Prompt | undefined {
	const t = text.trimStart();
	if (!t || CONTINUATIONS.some((r) => r.test(t))) return undefined;
	if (
		/^<command-name>\/compact<\/command-name>/.test(t) ||
		/<command-name>\/compact<\/command-name>/.test(t.slice(0, 200))
	)
		return { kind: "compact" };
	const head = t.slice(0, HEADER_WITHIN).match(WAKE_HEADER);
	if (head) {
		const kind = head[1]!;
		const id = text.match(DELIVERY_ID)?.[1];
		const variant =
			kind === "sweep"
				? /time for a full supervision sweep/.test(t.slice(0, HEADER_WITHIN))
					? "full"
					: "findings"
				: undefined;
		return { kind, ...(variant ? { variant } : {}), ...(id ? { deliveryId: id } : {}) };
	}
	if (/^You are the new Steward\b/.test(t)) return { kind: "start" };
	if (NOTICES.some((r) => r.test(t))) return { kind: "notice" };
	return { kind: "message" };
}

/** The text of a user row's prompt, or undefined when the row is not a prompt (a tool result, a meta row, a compaction summary). */
function promptText(r: any): string | undefined {
	if (r.isMeta || r.isCompactSummary || r.toolUseResult !== undefined) return undefined;
	const c = r.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c) || c.some((b: any) => b?.type === "tool_result")) return undefined;
	const text = c
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
	// An image with no words is still the principal speaking.
	return text || (c.some((b: any) => b?.type === "image") ? "[image]" : undefined);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const ms = (t: unknown): number | undefined => {
	const v = typeof t === "string" ? Date.parse(t) : Number.NaN;
	return Number.isFinite(v) ? v : undefined;
};

type Call = { input: number; cacheRead: number; cacheCreation: number; output: number; context: number };
type Open = Omit<
	WakeUsage,
	"requests" | "inputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "outputTokens"
> & {
	calls: Map<string, Call>;
};

/**
 * Splits one transcript into per-wake segments. Only canonical rows count: sidechains (subagents) and API request snapshots are skipped, and
 * a model request written as several rows (one per content block, the same `message.id`) counts once, with its last usage. A synthetic
 * assistant row (no model request) is not counted.
 */
export async function segmentTranscript(
	lines: AsyncIterable<string> | Iterable<string>,
	session: string,
): Promise<WakeUsage[]> {
	const out: Open[] = [];
	const seenKeys = new Map<string, number>();
	const owner = new Map<string, Open>();
	let cur: Open | undefined;
	const open = (key: string, p: Prompt, at: number | undefined): Open => {
		const n = (seenKeys.get(key) ?? 0) + 1;
		seenKeys.set(key, n);
		const seg: Open = {
			session,
			wakeKey: n === 1 ? key : `${key}#${n}`,
			kind: p.kind,
			...(p.variant ? { variant: p.variant } : {}),
			...(p.deliveryId ? { deliveryId: p.deliveryId } : {}),
			startedAt: at ?? 0,
			endedAt: at ?? 0,
			compactions: 0,
			calls: new Map(),
		};
		out.push(seg);
		return seg;
	};
	for await (const line of lines) {
		if (!line.trim()) continue;
		let r: any;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (r.isSidechain) continue;
		const at = ms(r.timestamp);
		if (r.type === "user") {
			const text = promptText(r);
			const p = text === undefined ? undefined : classifyPrompt(text);
			if (p) cur = open(p.deliveryId ?? `uuid:${r.uuid ?? out.length}`, p, at);
			continue;
		}
		if (r.type === "system" && r.subtype === "compact_boundary") {
			if (cur) cur.compactions++;
			continue;
		}
		if (r.type !== "assistant") continue;
		const u = r.message?.usage;
		if (!u || r.message?.model === "<synthetic>") continue;
		const id = String(r.message?.id ?? r.requestId ?? r.uuid ?? "");
		if (!id) continue;
		// A request continued across rows stays with the segment it started in.
		const seg = owner.get(id) ?? cur ?? (cur = open("preamble", { kind: "preamble" }, at));
		owner.set(id, seg);
		const call: Call = {
			input: num(u.input_tokens),
			cacheRead: num(u.cache_read_input_tokens),
			cacheCreation: num(u.cache_creation_input_tokens),
			output: num(u.output_tokens),
			context: 0,
		};
		call.context = call.input + call.cacheRead + call.cacheCreation;
		seg.calls.delete(id); // re-insert, so the map's order is the order each request last wrote
		seg.calls.set(id, call);
		if (at !== undefined) {
			if (!seg.startedAt) seg.startedAt = at;
			seg.endedAt = Math.max(seg.endedAt, at);
		}
	}
	return out.map(({ calls, ...s }) => {
		const list = [...calls.values()];
		const sum = (f: (c: Call) => number) => list.reduce((a, c) => a + f(c), 0);
		return {
			...s,
			requests: list.length,
			inputTokens: sum((c) => c.input),
			cacheReadInputTokens: sum((c) => c.cacheRead),
			cacheCreationInputTokens: sum((c) => c.cacheCreation),
			outputTokens: sum((c) => c.output),
			...(list.length
				? {
						contextStart: list[0]!.context,
						contextEnd: list.at(-1)!.context,
						contextPeak: Math.max(...list.map((c) => c.context)),
					}
				: {}),
		};
	});
}

/** Every token a segment processed: the four usage fields added. */
export const totalTokens = (w: WakeUsage): number =>
	w.inputTokens + w.cacheReadInputTokens + w.cacheCreationInputTokens + w.outputTokens;

/** Is this kind a wake Chamberlain sent (as opposed to the start prompt, a compaction, a notice or a message)? */
export const isWake = (kind: string): boolean => !["start", "compact", "notice", "message", "preamble"].includes(kind);

/** Reads and segments one transcript file. */
export async function readTranscript(path: string, session = basename(path, ".jsonl")): Promise<WakeUsage[]> {
	const stream = createReadStream(path, "utf8");
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		return await segmentTranscript(lines, session);
	} finally {
		lines.close();
		stream.destroy();
	}
}

/**
 * The Steward transcripts in one Claude Code project folder: every top-level `<session>.jsonl` that received at least one Chamberlain (or
 * t3-wake) wake. Chamberlain keeps no list of past Steward sessions (`switch-steward` overwrites `threads.steward`), so this is how the
 * backfill finds them: every Steward of a T3 install ran in the same folder. A file is opened only if its text names a wake header at all.
 */
export async function findStewardTranscripts(dir: string): Promise<string[]> {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
	const found: string[] = [];
	for (const f of files) {
		const path = join(dir, f);
		const text = await readFile(path, "utf8").catch(() => "");
		if (!text.includes("[chamberlain] ") && !text.includes("[t3-wake] ")) continue;
		if ((await segmentTranscript(text.split("\n"), basename(f, ".jsonl"))).some((s) => isWake(s.kind)))
			found.push(path);
	}
	return found;
}

export type BackfillResult = { files: number; sessions: string[]; rows: number; wakes: number };

/** Reads every given transcript and upserts its rows. Idempotent: a row's key is (session, wake key), and a rerun writes the same values. */
export async function backfill(store: Store, paths: string[]): Promise<BackfillResult> {
	let rows = 0,
		wakes = 0;
	const sessions: string[] = [];
	for (const p of paths) {
		const segs = await readTranscript(p);
		if (!segs.length) continue;
		store.usage.upsert(segs);
		sessions.push(basename(p, ".jsonl"));
		rows += segs.length;
		wakes += segs.filter((s) => isWake(s.kind)).length;
	}
	return { files: paths.length, sessions, rows, wakes };
}

// ---- the daemon's collector ------------------------------------------------------------------------

export const USAGE_KEY = "steward-usage";
export const USAGE_INTERVAL_MS = 60 * 60_000;
type UsageState = { at: string; path?: string };

/**
 * The daemon's hourly collector, on only when `stewardTokens` is on. It re-reads the Steward's current transcript and upserts its rows; when
 * the Steward has changed since the last run, it reads the previous transcript once more, so a hand-off loses none of the old session's last hour.
 */
export function usageTicker(deps: { store: Store; find: () => Promise<Transcript>; now?: () => number }) {
	let busy = false;
	return async () => {
		const now = (deps.now ?? Date.now)();
		const prior = deps.store.state.get<UsageState>(USAGE_KEY);
		if (busy || (prior && now - Date.parse(prior.at) < USAGE_INTERVAL_MS)) return;
		busy = true;
		try {
			const t = await deps.find();
			const paths = prior?.path && prior.path !== t.path ? [prior.path, t.path] : [t.path];
			for (const p of paths) {
				const segs = await readTranscript(p, p === t.path ? t.session : undefined).catch(() => []);
				if (segs.length) deps.store.usage.upsert(segs);
			}
			deps.store.state.set(USAGE_KEY, { at: new Date(now).toISOString(), path: t.path } satisfies UsageState);
		} finally {
			busy = false;
		}
	};
}

/** The folder the current Steward's transcript is in: where the backfill looks by default. */
export const transcriptDir = (t: Transcript): string => dirname(t.path);

// ---- the report ------------------------------------------------------------------------------------

/** The nearest-rank percentile of a list (p in 0..100); undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
	if (!values.length) return undefined;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export type KindStats = {
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

export function sessionTrends(rows: WakeUsage[]): SessionTrend[] {
	const by = new Map<string, WakeUsage[]>();
	for (const r of rows) by.set(r.session, [...(by.get(r.session) ?? []), r]);
	return [...by.entries()]
		.map(([session, rs]) => {
			rs.sort((a, b) => a.startedAt - b.startedAt);
			const ctx = rs.filter((r) => r.contextStart !== undefined);
			// The growth since the last compaction: a compaction resets the context, so the slope is measured after it.
			const lastCompact = rs.findLastIndex((r) => r.compactions > 0 || r.kind === "compact");
			const since = rs.slice(lastCompact + 1).filter((r) => isWake(r.kind) && r.contextStart !== undefined);
			const peaks = rs.flatMap((r) => (r.contextPeak === undefined ? [] : [r.contextPeak]));
			return {
				session,
				firstAt: rs[0]!.startedAt,
				wakes: rs.filter((r) => isWake(r.kind)).length,
				contextFirst: ctx[0]?.contextStart,
				contextLast: ctx.at(-1)?.contextStart,
				contextPeak: peaks.length ? Math.max(...peaks) : undefined,
				growthPerWake: slope(since.map((r) => r.contextStart!)),
			};
		})
		.sort((a, b) => a.firstAt - b.firstAt);
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

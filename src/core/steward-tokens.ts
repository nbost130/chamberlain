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
import type { Store } from "./store.ts";
import type { WakeUsage } from "./store-records.ts";

export type { WakeUsage } from "./store-records.ts";

/**
 * The wake header every Chamberlain wake starts with (`t3-wake` is the name it had before), recognised only where a wake puts it: at the
 * very start of the prompt, or at the start of T3's webhook envelope (`<webhook-data-<id>>`). A header quoted in a message is not a wake.
 */
const WAKE_HEADER = /(?:^|<webhook-data-[0-9a-f]+>)\[(?:chamberlain|t3-wake)\] ([a-z][a-z0-9_-]*):/;
/**
 * The wake kinds Chamberlain (and t3-wake before it) has sent. A header naming any other word is stored as `wake`: the kind is a fixed
 * vocabulary, so no word of a transcript ever reaches the database or a report.
 */
const WAKE_KINDS = [
	"turn_ended",
	"needs_input",
	"failed",
	"answer",
	"digest",
	"sweep",
	"rights",
	"steward-handoff",
	"handoff",
	"idle-parents",
	"fresh",
	"alert_desk",
] as const;
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

/** The compact command, as the first thing in a prompt. */
const isCompactCommand = (t: string): boolean =>
	/^<command-name>\/compact<\/command-name>/.test(t) || /<command-name>\/compact<\/command-name>/.test(t.slice(0, 200));

/** A wake: its kind (a word outside the fixed vocabulary is `wake`), a sweep's variant, and its delivery id when it carries one. */
function wakePrompt(text: string, t: string, word: string): Prompt {
	const kind = (WAKE_KINDS as readonly string[]).includes(word) ? word : "wake";
	const id = text.match(DELIVERY_ID)?.[1];
	const variant =
		kind === "sweep"
			? /time for a full supervision sweep/.test(t.slice(0, HEADER_WITHIN))
				? "full"
				: "findings"
			: undefined;
	return { kind, ...(variant ? { variant } : {}), ...(id ? { deliveryId: id } : {}) };
}

/**
 * What a turn-starting prompt is: a wake of some kind, `start`, `compact`, `notice` or `message`, or undefined when it continues the segment in
 * progress. Pure: the text is read here and never kept.
 */
export function classifyPrompt(text: string): Prompt | undefined {
	const t = text.trimStart();
	if (!t || CONTINUATIONS.some((r) => r.test(t))) return undefined;
	if (isCompactCommand(t)) return { kind: "compact" };
	const head = t.slice(0, HEADER_WITHIN).match(WAKE_HEADER);
	if (head) return wakePrompt(text, t, head[1] ?? "");
	if (/^You are the new Steward\b/.test(t)) return { kind: "start" };
	if (NOTICES.some((r) => r.test(t))) return { kind: "notice" };
	return { kind: "message" };
}

/** One transcript row, as far as this file reads it. Rows come from JSON, so every field may be missing or odd. */
type Row = {
	isSidechain?: unknown;
	isMeta?: unknown;
	isCompactSummary?: unknown;
	toolUseResult?: unknown;
	type?: string;
	subtype?: string;
	uuid?: unknown;
	parentUuid?: unknown;
	requestId?: unknown;
	timestamp?: unknown;
	message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown>; content?: unknown };
};
type ContentBlock = { type?: unknown; text?: unknown } | null | undefined;

/** The text of a user row's prompt, or undefined when the row is not a prompt (a tool result, a meta row, a compaction summary). */
function promptText(r: Row): string | undefined {
	if (r.isMeta || r.isCompactSummary || r.toolUseResult !== undefined) return undefined;
	const c = r.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return undefined;
	const blocks = c as ContentBlock[];
	if (blocks.some((b) => b?.type === "tool_result")) return undefined;
	const text = blocks.flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
	// An image with no words is still the principal speaking.
	return text || (blocks.some((b) => b?.type === "image") ? "[image]" : undefined);
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

/** What `segmentTranscript` carries from row to row. */
type Segmenter = {
	session: string;
	out: Open[];
	seenKeys: Map<string, number>;
	/** The segment a model request started in, by request id: its later rows stay with it. */
	owner: Map<string, Open>;
	/**
	 * The segment each row belongs to, by its uuid. A row belongs to its parent row's segment (Claude Code links every row to the one before
	 * it in the conversation), so a prompt written while an earlier request is still running takes none of that request's rows. A row whose
	 * parent is unknown falls back to the latest prompt.
	 */
	rowSeg: Map<string, Open>;
	cur: Open | undefined;
};

const parentSeg = (sg: Segmenter, r: Row): Open | undefined =>
	(r.parentUuid ? sg.rowSeg.get(String(r.parentUuid)) : undefined) ?? sg.cur;

const markRow = (sg: Segmenter, r: Row, seg: Open | undefined) => {
	if (seg && r.uuid) sg.rowSeg.set(String(r.uuid), seg);
};

function openSegment(sg: Segmenter, key: string, p: Prompt, at: number | undefined): Open {
	const n = (sg.seenKeys.get(key) ?? 0) + 1;
	sg.seenKeys.set(key, n);
	const seg: Open = {
		session: sg.session,
		wakeKey: n === 1 ? key : `${key}#${n}`,
		kind: p.kind,
		...(p.variant ? { variant: p.variant } : {}),
		...(p.deliveryId ? { deliveryId: p.deliveryId } : {}),
		startedAt: at ?? 0,
		endedAt: at ?? 0,
		compactions: 0,
		calls: new Map(),
	};
	sg.out.push(seg);
	return seg;
}

/** A user row starts a segment when it is a turn-starting prompt; any other user row belongs to its parent's segment. */
function scanUser(sg: Segmenter, r: Row, at: number | undefined) {
	const text = promptText(r);
	const p = text === undefined ? undefined : classifyPrompt(text);
	if (p) {
		sg.cur = openSegment(sg, p.deliveryId ?? `uuid:${r.uuid ?? sg.out.length}`, p, at);
		markRow(sg, r, sg.cur);
	} else markRow(sg, r, parentSeg(sg, r));
}

/** One model request's usage: the four fields, and the context size they make up. */
function callOf(u: Record<string, unknown>): Call {
	const input = num(u.input_tokens),
		cacheRead = num(u.cache_read_input_tokens),
		cacheCreation = num(u.cache_creation_input_tokens);
	return { input, cacheRead, cacheCreation, output: num(u.output_tokens), context: input + cacheRead + cacheCreation };
}

/** An assistant row: a counted model request goes to the segment it started in, or else to its parent row's. */
function scanAssistant(sg: Segmenter, r: Row, at: number | undefined) {
	const u = r.message?.usage;
	const id = String(r.message?.id ?? r.requestId ?? r.uuid ?? "");
	// A request continued across rows stays with the segment it started in; a new one goes to its parent row's segment.
	const found = (id ? sg.owner.get(id) : undefined) ?? parentSeg(sg, r);
	markRow(sg, r, found);
	if (!u || !id || r.message?.model === "<synthetic>") return;
	let seg = found;
	if (!seg) {
		seg = openSegment(sg, "preamble", { kind: "preamble" }, at);
		sg.cur = seg;
	}
	markRow(sg, r, seg);
	sg.owner.set(id, seg);
	// A later row of the same request replaces its usage but keeps its place: the map's order is the order the requests started.
	seg.calls.set(id, callOf(u));
	if (at !== undefined) {
		if (!seg.startedAt) seg.startedAt = at;
		seg.endedAt = Math.max(seg.endedAt, at);
	}
}

/** Folds one transcript line into the segments. */
function scanSegmentLine(sg: Segmenter, line: string) {
	if (!line.trim()) return;
	let r: Row;
	try {
		r = JSON.parse(line);
	} catch {
		return;
	}
	if (r.isSidechain) return;
	const at = ms(r.timestamp);
	if (r.type === "user") scanUser(sg, r, at);
	else if (r.type === "system" && r.subtype === "compact_boundary") {
		const seg = parentSeg(sg, r);
		if (seg) seg.compactions++;
		markRow(sg, r, seg);
	} else if (r.type === "assistant") scanAssistant(sg, r, at);
	else markRow(sg, r, parentSeg(sg, r));
}

/** A segment's requests summed, with the context size at its first, last and largest request. */
function finishSegment({ calls, ...s }: Open): WakeUsage {
	const list = [...calls.values()];
	const sum = (f: (c: Call) => number) => list.reduce((a, c) => a + f(c), 0);
	const first = list[0];
	const last = list.at(-1);
	return {
		...s,
		requests: list.length,
		inputTokens: sum((c) => c.input),
		cacheReadInputTokens: sum((c) => c.cacheRead),
		cacheCreationInputTokens: sum((c) => c.cacheCreation),
		outputTokens: sum((c) => c.output),
		...(first && last
			? {
					contextStart: first.context,
					contextEnd: last.context,
					contextPeak: Math.max(...list.map((c) => c.context)),
				}
			: {}),
	};
}

/**
 * Splits one transcript into per-wake segments. Only canonical rows count: sidechains (subagents) and API request snapshots are skipped, and
 * a model request written as several rows (one per content block, the same `message.id`) counts once, with its last usage. A synthetic
 * assistant row (no model request) is not counted.
 */
export async function segmentTranscript(
	lines: AsyncIterable<string> | Iterable<string>,
	session: string,
): Promise<WakeUsage[]> {
	const sg: Segmenter = {
		session,
		out: [],
		seenKeys: new Map(),
		owner: new Map(),
		rowSeg: new Map(),
		cur: undefined,
	};
	for await (const line of lines) scanSegmentLine(sg, line);
	return sg.out.map(finishSegment);
}

/** Every token a segment processed: the four usage fields added. */
export const totalTokens = (w: WakeUsage): number =>
	w.inputTokens + w.cacheReadInputTokens + w.cacheCreationInputTokens + w.outputTokens;

/** Is this kind a wake Chamberlain sent (as opposed to the start prompt, a compaction, a notice or a message)? */
const isWake = (kind: string): boolean => !["start", "compact", "notice", "message", "preamble"].includes(kind);

/** Reads and segments one transcript file. */
async function readTranscript(path: string, session = basename(path, ".jsonl")): Promise<WakeUsage[]> {
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

/** The backfill's arguments: `--dir <folder>` and any transcript files named. */
export function parseBackfillArgs(argv: string[]): { dir?: string; files: string[] } {
	const at = argv.indexOf("--dir");
	const dir = at >= 0 ? argv[at + 1] : undefined;
	if (at >= 0 && !dir) throw Error("--dir needs a folder");
	const files = argv.filter((_a, i) => i !== at && !(at >= 0 && i === at + 1));
	const bad = files.find((f) => !f.endsWith(".jsonl"));
	if (bad) throw Error(`not a transcript (.jsonl): ${bad}`);
	return { ...(dir !== undefined ? { dir } : {}), files };
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
/** `retry`: transcripts of earlier Stewards whose last read failed, read again on the next run until one succeeds or the file is gone. */
type UsageState = { at: string; path?: string; retry?: string[] };

type UsageDeps = { store: Store; find: () => Promise<Transcript>; now?: () => number };

/** Reads and stores one transcript. A failed read is reported, and an earlier transcript that is not gone is kept for the next run. */
async function collectTranscript(
	store: Store,
	p: string,
	t: Transcript,
	out: { retry: string[]; failed: string[] },
): Promise<void> {
	try {
		const segs = await readTranscript(p, p === t.path ? t.session : undefined);
		if (segs.length) store.usage.upsert(segs);
	} catch (e) {
		out.failed.push(`${basename(p)}: ${String(e).slice(0, 120)}`);
		// The current transcript is read again every run anyway; an earlier one is kept for the next run unless it is gone.
		if (p !== t.path && (e as NodeJS.ErrnoException).code !== "ENOENT") out.retry.push(p);
	}
}

/** One run: the earlier transcripts still owed, then the current one. What it could not read comes back, and the run's state is saved. */
async function collectUsage(deps: UsageDeps, now: number, prior: UsageState | undefined): Promise<string[]> {
	const t = await deps.find();
	const earlier = [...(prior?.retry ?? []), ...(prior?.path ? [prior.path] : [])].filter((p) => p !== t.path);
	const out = { retry: [] as string[], failed: [] as string[] };
	for (const p of [...new Set(earlier), t.path]) await collectTranscript(deps.store, p, t, out);
	deps.store.state.set(USAGE_KEY, {
		at: new Date(now).toISOString(),
		path: t.path,
		...(out.retry.length ? { retry: out.retry } : {}),
	} satisfies UsageState);
	return out.failed;
}

/**
 * The daemon's hourly collector, on only when `stewardTokens` is on. It re-reads the Steward's current transcript and upserts its rows; when
 * the Steward has changed since the last run, it reads the previous transcript once more, so a hand-off loses none of the old session's last hour.
 */
export function usageTicker(deps: UsageDeps) {
	let busy = false;
	return async () => {
		const now = (deps.now ?? Date.now)();
		const prior = deps.store.state.get<UsageState>(USAGE_KEY);
		if (busy || (prior && now - Date.parse(prior.at) < USAGE_INTERVAL_MS)) return;
		busy = true;
		try {
			const failed = await collectUsage(deps, now, prior);
			if (failed.length) throw Error(`could not read ${failed.join("; ")}`);
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

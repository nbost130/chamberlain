/** Cutting the Steward's Claude Code transcript into segments: one wake, the start prompt, a compaction, a notice or a message, each with its token numbers. */
import type { WakeUsage } from "./store-records.ts";

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

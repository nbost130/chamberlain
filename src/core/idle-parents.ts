/**
 * The `idle-parents` check: every top-level thread that finished its work and has sat idle past a threshold, reported to the
 * Steward in one compact list. A turn-end wake can miss a thread (its closing words matched no rule, or the wake went to a
 * Steward that was busy), and a thread that waits for a word never moves on its own; this check is the net under those misses.
 *
 * It runs on its own timer (`intervalMinutes`, default 15), not on the two-hourly routine sweep (src/core/engine-idle.ts). Selection
 * and ordering are plain code. An optional classifier (`classifier`, off by default; src/core/classifier/) can sort the selection: in
 * `live` mode only the threads it calls escalate, nudge or unknown are reported, tagged, and the settled ones go into one digest line a
 * day; in `shadow` mode it only records what it would have done, and the report is exactly as without it. `selectIdleThreads` is the one place that decides which threads are idle,
 * and it returns plain records, so anything that later wants to classify or record a thread's disposition starts from them.
 * Who started the thread's last turn does not matter: a thread the principal asked a question of and that then sat on a half-answer
 * is reported like any other. (The turn-ended wake skips such turns on purpose; this check is what catches the ones that stall.)
 *
 * It is an item source (src/core/source.ts), named `check:idle-parents`, so the item system alone decides what notifies:
 * one finding per thread and last message, keyed by a hash of that message. A thread already reported with the same last
 * message is never reported again, however many ticks pass; a new message makes a new finding. Threads whose last message
 * reads as an ask (`looksLikeAsk`) come first.
 *
 * Config (`sweep.idleParents` in config.json): `enabled` (default true), `intervalMinutes` (15), `thresholdMinutes` (30), `maxThreads`
 * (10, the most NEW threads one wake lists; the rest are listed on a later tick), `classifier` (src/core/classifier/config.ts).
 */
import { createHash } from "node:crypto";
import type { LastAssistant, ThreadState } from "./adapter.ts";
import type { Classified } from "./classifier/classify.ts";
import { type ClassifierConfig, CLASSIFIER_DEFAULTS, parseClassifier } from "./classifier/config.ts";
import { looksLikeAsk } from "./decide.ts";
import type { Finding, ItemSource } from "./source.ts";
import type { Store } from "./store.ts";

export const IDLE_PARENTS = "idle-parents";
/** The item source name: the same `check:<name>` form every routine check has. */
export const IDLE_PARENTS_SOURCE = `check:${IDLE_PARENTS}`;

export type IdleParentsConfig = {
	enabled: boolean;
	intervalMinutes: number;
	thresholdMinutes: number;
	maxThreads: number;
	classifier: ClassifierConfig;
};
export const IDLE_PARENTS_DEFAULTS: IdleParentsConfig = {
	enabled: true,
	intervalMinutes: 15,
	thresholdMinutes: 30,
	maxThreads: 10,
	classifier: CLASSIFIER_DEFAULTS,
};
/** How much of the last message a finding carries. The tail, because that is where a question sits. */
export const EXCERPT_CHARS = 300;

const KEYS = ["enabled", "intervalMinutes", "thresholdMinutes", "maxThreads", "classifier"];
/** Pure: the `sweep.idleParents` section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseIdleParents(raw: unknown): IdleParentsConfig {
	if (raw === undefined) return { ...IDLE_PARENTS_DEFAULTS, classifier: parseClassifier(undefined) };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("sweep.idleParents: expected an object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!KEYS.includes(k)) throw Error(`sweep.idleParents: unknown key "${k}" (known: ${KEYS.join(", ")})`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error("sweep.idleParents: enabled must be true or false");
	const num = (k: "intervalMinutes" | "thresholdMinutes" | "maxThreads", whole: boolean) => {
		const v = o[k];
		if (v === undefined) return IDLE_PARENTS_DEFAULTS[k];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (whole && !Number.isInteger(v)))
			throw Error(`sweep.idleParents: ${k} must be a positive ${whole ? "whole " : ""}number`);
		return v;
	};
	return {
		enabled: o.enabled ?? IDLE_PARENTS_DEFAULTS.enabled,
		intervalMinutes: num("intervalMinutes", false),
		thresholdMinutes: num("thresholdMinutes", false),
		maxThreads: num("maxThreads", true),
		classifier: parseClassifier(o.classifier),
	};
}

/**
 * Pure: can this thread be an idle parent? Top level (no child or subagent), not settled, snoozed or archived, finished
 * (`idle` or `completed`, so not waiting on a card, running, failed or interrupted), with nothing of its own still running, and
 * not one of the threads that belong to Chamberlain itself or the operator's exclude list (`skip`: the Steward, the decisions
 * thread, the Alert Desk).
 */
export function idleParentCandidate(th: ThreadState, skip: ReadonlySet<string>, liveChildren = 0): boolean {
	return (
		th.parentThreadId === null &&
		!th.settled &&
		!th.snoozed &&
		!th.archived &&
		(th.status === "idle" || th.status === "completed") &&
		th.pendingRequestId === null &&
		th.backgroundTasks === 0 &&
		liveChildren === 0 &&
		!skip.has(th.id)
	);
}

/**
 * One idle thread, as plain data. `lastMessage` is the whole text; `lastMessageHash` names that message (id and text). `previous` is the
 * user message before it and who wrote it (`none`: there is none, or the adapter cannot say); only the classifier reads it.
 */
export type IdleThread = {
	server: string;
	threadId: string;
	title: string;
	idleMinutes: number;
	lastMessage: string;
	lastMessageHash: string;
	looksLikeAsk: boolean;
	previous: { from: "human" | "agent" | "none"; text: string };
};

/** What a watcher offers the selection: its threads as it last saw them, and how to read one thread's last message. */
export type IdleThreadSource = {
	server: string;
	connected: boolean;
	threads: Iterable<ThreadState>;
	/** Running children of a thread (their completion wakes it, so it is not idle). */
	liveChildren(threadId: string): number;
	/**
	 * Subagents the thread itself runs, which its own projection knows and the thread table does not (the turn-end path asks the same:
	 * Inspector.runningSubagents). A thread with any running is not idle. Absent: the adapter cannot say.
	 */
	runningSubagents?: (threadId: string) => Promise<number>;
	/** Absent: this adapter's threads cannot be read, so none is selected. */
	lastAssistant?: (threadId: string) => Promise<LastAssistant | undefined>;
	/** Called once for a thread whose read threw. */
	readFailed?: (threadId: string, error: unknown) => void;
};

/** What the selection found: the idle threads, and those it could not read (kept as they were, never read as cleared). */
export type IdleSelection = { threads: IdleThread[]; unreadable: { server: string; threadId: string }[] };

/** Pure: the identity of one last message, stable for the same message and different for the next one. */
export const messageHash = (last: Pick<LastAssistant, "id" | "text">): string =>
	createHash("sha256").update(`${last.id}\0${last.text}`).digest("hex").slice(0, 12);

/** Pure: asks first, then the longest idle, then by server and thread, so the order is the same on every run. */
export const byAskThenIdle = (a: IdleThread, b: IdleThread): number =>
	Number(b.looksLikeAsk) - Number(a.looksLikeAsk) ||
	b.idleMinutes - a.idleMinutes ||
	(`${a.server}\0${a.threadId}` < `${b.server}\0${b.threadId}` ? -1 : 1);

/**
 * THE idle-thread selection. From each source's threads: the candidates (`idleParentCandidate`) whose last finished assistant message
 * ended more than `thresholdMinutes` before `now`, as plain records, asks first and then the longest idle. A disconnected source, or a
 * thread whose read throws, is `unreadable` (its earlier report stays as it was). No model is called: `looksLikeAsk` is a regular
 * expression. Reads go a few at a time, one projection each.
 */
export async function selectIdleThreads(
	sources: readonly IdleThreadSource[],
	now: number,
	o: { thresholdMinutes: number; skip?: ReadonlySet<string> },
): Promise<IdleSelection> {
	const skip = o.skip ?? new Set<string>();
	const out: IdleSelection = { threads: [], unreadable: [] };
	for (const src of sources) {
		const read = src.lastAssistant;
		if (!read) continue;
		const candidates = [...src.threads].filter((th) => idleParentCandidate(th, skip, src.liveChildren(th.id)));
		if (!src.connected) {
			for (const th of candidates) out.unreadable.push({ server: src.server, threadId: th.id });
			continue;
		}
		const one = async (th: ThreadState) => {
			try {
				if (src.runningSubagents && (await src.runningSubagents(th.id)) > 0) return;
				const last = await read(th.id);
				const at = last ? Date.parse(last.at) : Number.NaN;
				if (!last || !Number.isFinite(at)) return;
				const idleMs = now - at;
				if (idleMs <= o.thresholdMinutes * 60_000) return;
				out.threads.push({
					server: src.server,
					threadId: th.id,
					title: th.title,
					idleMinutes: Math.floor(idleMs / 60_000),
					lastMessage: last.text,
					lastMessageHash: messageHash(last),
					looksLikeAsk: looksLikeAsk(last.text),
					previous: last.previous ? { from: last.previous.by, text: last.previous.text } : { from: "none", text: "" },
				});
			} catch (e) {
				src.readFailed?.(th.id, e);
				out.unreadable.push({ server: src.server, threadId: th.id });
			}
		};
		for (let i = 0; i < candidates.length; i += 8) await Promise.all(candidates.slice(i, i + 8).map(one));
	}
	out.threads.sort(byAskThenIdle);
	return out;
}

/** Pure: the last of a message, whitespace collapsed, cut at the start so the end (where an ask is) stays. */
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `…${flat.slice(-max).toWellFormed()}` : flat;
}

const clipTitle = (s: string) => (s.length > 80 ? `${s.slice(0, 79).toWellFormed()}…` : s);
/** Pure: the item key of one thread at one last message. */
export const idleKey = (t: Pick<IdleThread, "server" | "threadId" | "lastMessageHash">) =>
	`${t.server}:${t.threadId}:${t.lastMessageHash}`;
/** Pure: how one idle thread reads in the wake. */
export const idleText = (t: IdleThread) =>
	`${t.looksLikeAsk ? "[ASKING] " : ""}thread "${clipTitle(t.title)}" on ${t.server} (threadId ${t.threadId}), idle ${t.idleMinutes} min. Last message: ${excerptOf(t.lastMessage)}`;
/** Pure: the tag a live classification puts first: the action and the questions that fired, e.g. `[ESCALATE asks_decision 0.98]`. */
export const classTag = (c: Pick<Classified, "action" | "reasons">) =>
	`[${c.action.toUpperCase()}${c.reasons.map((r) => ` ${r.id} ${r.p.toFixed(2)}`).join(",")}]`;
/** Pure: how a thread the classifier sorted reads in a live wake. Unknown (unclassified) reads exactly as without the classifier. */
export const classifiedText = (t: IdleThread, c: Classified | undefined) =>
	c && (c.action === "escalate" || c.action === "nudge")
		? `${classTag(c)} thread "${clipTitle(t.title)}" on ${t.server} (threadId ${t.threadId}), idle ${t.idleMinutes} min. Last message: ${excerptOf(t.lastMessage)}`
		: idleText(t);

/** The item key of the day's settled digest line: one per UTC day. */
export const DIGEST_PREFIX = "settled-digest:";
export const digestKey = (day: string) => `${DIGEST_PREFIX}${day}`;
const DIGEST_TITLES = 12;
/** Pure: the digest line for the threads a live classifier called settled. */
export const digestText = (settled: readonly IdleThread[]) => {
	const shown = settled
		.slice(0, DIGEST_TITLES)
		.map((t) => `"${clipTitle(t.title)}" on ${t.server}`)
		.join(", ");
	const more = settled.length > DIGEST_TITLES ? `, and ${settled.length - DIGEST_TITLES} more` : "";
	return `${settled.length} idle thread${settled.length === 1 ? "" : "s"} look${settled.length === 1 ? "s" : ""} finished (the classifier's settle; not reported one by one): ${shown}${more}.`;
};

/** What a classifier run gives the findings: its mode, the UTC day, and a disposition per item key (absent: unclassified). */
export type IdleClassification = { mode: "shadow" | "live"; day: string; byKey: ReadonlyMap<string, Classified> };
const RANK: Record<string, number> = { escalate: 0, nudge: 1, unknown: 2 };

/** What the check holds as items, open or resolved: a key, the text it last carried, and whether it has resolved. */
export type PriorFinding = { dedupKey: string; text: string; resolved?: boolean };

/** The check's items as `PriorFinding`s: every one, because a thread that came back after a resolve was already reported. */
export const idlePrior = (store: Pick<Store, "items">): PriorFinding[] =>
	store.items.list({ source: IDLE_PARENTS_SOURCE }).map((i) => ({
		dedupKey: i.dedupKey,
		text: String(i.payload.text ?? i.dedupKey),
		resolved: i.status === "resolved",
	}));

/**
 * Pure: the findings for a selection. A thread is reported once per last message, however its eligibility moves: a key the check has an
 * item for, resolved or not, was already reported, so it never counts against the cap, and one that comes back after a resolve (it was
 * snoozed, or briefly running) is marked `alreadyReported` and returns acknowledged, not as news. The cap limits the NEW threads only,
 * in the selection's order. A thread the selection could not read keeps the open finding it had.
 */
export function idleParentFindings(
	sel: IdleSelection,
	cfg: Pick<IdleParentsConfig, "maxThreads">,
	prior: readonly PriorFinding[] = [],
	cls?: IdleClassification,
): Finding[] {
	const known = new Set(prior.map((p) => p.dedupKey));
	let fresh = 0;
	const out: Finding[] = [];
	// Live: only escalate, nudge and unknown are reported, in that order and then by idle time; settle goes into the day's digest line.
	const live = cls?.mode === "live";
	const actionOf = (t: IdleThread) => cls?.byKey.get(idleKey(t))?.action ?? "unknown";
	const threads = live
		? sel.threads
				.filter((t) => actionOf(t) in RANK)
				.sort(
					(a, b) =>
						RANK[actionOf(a)]! - RANK[actionOf(b)]! ||
						b.idleMinutes - a.idleMinutes ||
						(`${a.server}\0${a.threadId}` < `${b.server}\0${b.threadId}` ? -1 : 1),
				)
		: sel.threads;
	for (const t of threads) {
		const dedupKey = idleKey(t);
		const seen = known.has(dedupKey);
		if (!seen && ++fresh > cfg.maxThreads) continue;
		const text = live ? classifiedText(t, cls!.byKey.get(dedupKey)) : idleText(t);
		out.push({ dedupKey, text, ...(seen ? { alreadyReported: true } : {}) });
	}
	if (live) {
		const settled = sel.threads.filter((t) => actionOf(t) === "settle");
		const key = digestKey(cls!.day);
		if (settled.length && !known.has(key)) out.push({ dedupKey: key, text: digestText(settled) });
	}
	const have = new Set(out.map((f) => f.dedupKey));
	for (const u of sel.unreadable) {
		const stem = `${u.server}:${u.threadId}:`;
		for (const p of prior)
			if (p.dedupKey.startsWith(stem) && !p.resolved && !have.has(p.dedupKey))
				out.push({ dedupKey: p.dedupKey, text: p.text });
	}
	return out;
}

/** The check as an item source. `select` is `selectIdleThreads` over the watchers; `prior` lists the source's open items. */
export function idleParentsSource(o: {
	cfg: Pick<IdleParentsConfig, "maxThreads">;
	select: () => Promise<IdleSelection>;
	prior: () => PriorFinding[];
	/** The classifier, when it is on: a disposition per selected thread. It never throws (src/core/classifier/classify.ts). */
	classify?: (threads: readonly IdleThread[]) => Promise<IdleClassification>;
}): ItemSource {
	return {
		name: IDLE_PARENTS_SOURCE,
		run: async () => {
			const sel = await o.select();
			const cls = o.classify ? await o.classify(sel.threads) : undefined;
			return idleParentFindings(sel, o.cfg, o.prior(), cls);
		},
	};
}

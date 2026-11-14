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
import type { Classified } from "./classifier/classify.ts";
import { CLASSIFIER_DEFAULTS, type ClassifierConfig, parseClassifier } from "./classifier/config.ts";
import type { IdleSelection, IdleThread } from "./idle-select.ts";
import type { Finding, ItemSource } from "./source.ts";
import type { Store } from "./store.ts";

export const IDLE_PARENTS = "idle-parents";
/** The item source name: the same `check:<name>` form every routine check has. */
const IDLE_PARENTS_SOURCE = `check:${IDLE_PARENTS}`;

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
const classifiedText = (t: IdleThread, c: Classified | undefined) =>
	c && (c.action === "escalate" || c.action === "nudge")
		? `${classTag(c)} thread "${clipTitle(t.title)}" on ${t.server} (threadId ${t.threadId}), idle ${t.idleMinutes} min. Last message: ${excerptOf(t.lastMessage)}`
		: idleText(t);

/** The item key of the day's settled digest line: one per UTC day. */
export const DIGEST_PREFIX = "settled-digest:";
const digestKey = (day: string) => `${DIGEST_PREFIX}${day}`;
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
	const live = cls?.mode === "live" ? cls : undefined;
	const out = reportedThreads(sel.threads, cfg.maxThreads, known, live);
	if (live) {
		const settled = sel.threads.filter((t) => actionOf(t, live) === "settle");
		const key = digestKey(live.day);
		if (settled.length && !known.has(key)) out.push({ dedupKey: key, text: digestText(settled) });
	}
	out.push(...keptOpen(sel.unreadable, prior, out));
	return out;
}

/** Pure: the disposition a live classification gave one thread (absent: unknown). */
const actionOf = (t: IdleThread, live: IdleClassification) => live.byKey.get(idleKey(t))?.action ?? "unknown";

/** Pure: the threads as findings, within the cap on the new ones. Live: only escalate, nudge and unknown are reported, in that order and then by idle time; settle goes into the day's digest line. */
function reportedThreads(
	all: readonly IdleThread[],
	maxThreads: number,
	known: ReadonlySet<string>,
	live: IdleClassification | undefined,
): Finding[] {
	const rank = (t: IdleThread, l: IdleClassification) => RANK[actionOf(t, l)] ?? 2; // only called on actions that are in RANK
	const threads = live
		? all
				.filter((t) => actionOf(t, live) in RANK)
				.sort(
					(a, b) =>
						rank(a, live) - rank(b, live) ||
						b.idleMinutes - a.idleMinutes ||
						(`${a.server}\0${a.threadId}` < `${b.server}\0${b.threadId}` ? -1 : 1),
				)
		: all;
	let fresh = 0;
	const out: Finding[] = [];
	for (const t of threads) {
		const dedupKey = idleKey(t);
		const seen = known.has(dedupKey);
		if (!seen && ++fresh > maxThreads) continue;
		const text = live ? classifiedText(t, live.byKey.get(dedupKey)) : idleText(t);
		out.push({ dedupKey, text, ...(seen ? { alreadyReported: true } : {}) });
	}
	return out;
}

/** Pure: the open findings of threads the selection could not read, which keep what they had (those not already in `out`). */
function keptOpen(
	unreadable: IdleSelection["unreadable"],
	prior: readonly PriorFinding[],
	out: readonly Finding[],
): Finding[] {
	const have = new Set(out.map((f) => f.dedupKey));
	const kept: Finding[] = [];
	for (const u of unreadable) {
		const stem = `${u.server}:${u.threadId}:`;
		for (const p of prior)
			if (p.dedupKey.startsWith(stem) && !p.resolved && !have.has(p.dedupKey))
				kept.push({ dedupKey: p.dedupKey, text: p.text });
	}
	return kept;
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

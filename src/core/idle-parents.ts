/**
 * The `idle-parents` routine check: every top-level thread that finished its work and has sat idle past a threshold, reported to
 * the Steward in one compact list. A turn-end wake can miss a thread (its closing words matched no rule, or the wake went to a
 * Steward that was busy), and a thread that waits for a word never moves on its own; this check is the net under those misses.
 *
 * It is an item source (src/core/source.ts), named `check:idle-parents`, so the item system alone decides what notifies:
 * one finding per thread and last message, keyed by a hash of that message. A thread already reported with the same last
 * message is never reported again; a new message makes a new finding. Threads whose last message reads as an ask
 * (`looksLikeAsk`) come first.
 *
 * Config (`sweep.idleParents` in config.json): `enabled` (default true), `thresholdMinutes` (default 60), `maxThreads` (default 10,
 * the most NEW threads one wake lists; the rest are listed on a later sweep).
 */
import { createHash } from "node:crypto";
import type { LastAssistant, ThreadState } from "./adapter.ts";
import { looksLikeAsk } from "./decide.ts";
import type { Finding, ItemSource } from "./source.ts";

export const IDLE_PARENTS = "idle-parents";
/** The item source name: the same `check:<name>` form every routine check has. */
export const IDLE_PARENTS_SOURCE = `check:${IDLE_PARENTS}`;

export type IdleParentsConfig = { enabled: boolean; thresholdMinutes: number; maxThreads: number };
export const IDLE_PARENTS_DEFAULTS: IdleParentsConfig = { enabled: true, thresholdMinutes: 60, maxThreads: 10 };
/** How much of the last message a finding carries. The tail, because that is where a question sits. */
export const EXCERPT_CHARS = 300;

/** Pure: the `sweep.idleParents` section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseIdleParents(raw: unknown): IdleParentsConfig {
	if (raw === undefined) return { ...IDLE_PARENTS_DEFAULTS };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("sweep.idleParents: expected an object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!["enabled", "thresholdMinutes", "maxThreads"].includes(k))
			throw Error(`sweep.idleParents: unknown key "${k}" (known: enabled, thresholdMinutes, maxThreads)`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error("sweep.idleParents: enabled must be true or false");
	const num = (k: "thresholdMinutes" | "maxThreads", whole: boolean) => {
		const v = o[k];
		if (v === undefined) return IDLE_PARENTS_DEFAULTS[k];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (whole && !Number.isInteger(v)))
			throw Error(`sweep.idleParents: ${k} must be a positive ${whole ? "whole " : ""}number`);
		return v;
	};
	return {
		enabled: o.enabled ?? IDLE_PARENTS_DEFAULTS.enabled,
		thresholdMinutes: num("thresholdMinutes", false),
		maxThreads: num("maxThreads", true),
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

/** One idle thread as a watcher read it. `at` is when its last message finished, in ms. */
export type IdleParentFact = {
	server: string;
	id: string;
	title: string;
	last: LastAssistant;
	at: number;
};
/** What a gather found: the idle parents it could read, and the threads it could not read (kept as they were, never read as cleared). */
export type IdleParentsRead = { facts: IdleParentFact[]; unreadable: { server: string; id: string }[] };

/** Pure: the identity of one last message, stable for the same message and different for the next one. */
export const messageHash = (last: Pick<LastAssistant, "id" | "text">): string =>
	createHash("sha256").update(`${last.id}\0${last.text}`).digest("hex").slice(0, 12);

/** Pure: the last of a message, whitespace collapsed, cut at the start so the end (where an ask is) stays. */
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

const keyOf = (f: Pick<IdleParentFact, "server" | "id" | "last">) => `${f.server}:${f.id}:${messageHash(f.last)}`;
const clipTitle = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/** What the check already holds as open items: a key and the text it last carried. */
export type PriorFinding = { dedupKey: string; text: string };

/**
 * Pure: the findings for what a gather read. A fact qualifies when its last message finished more than the threshold ago.
 * Order: asks first, then the longest idle, then by key, so the order is the same on every run. The cap limits the NEW threads
 * only, in that order: a thread already open (`prior`) is always returned, or the item system would resolve it and report it
 * again when it came back. A thread the gather could not read keeps what it had.
 */
export function idleParentFindings(
	read: IdleParentsRead,
	now: number,
	cfg: IdleParentsConfig,
	prior: readonly PriorFinding[] = [],
): Finding[] {
	const open = new Map(prior.map((p) => [p.dedupKey, p]));
	const rows = read.facts
		.filter((f) => now - f.at > cfg.thresholdMinutes * 60_000)
		.map((f) => {
			const asking = looksLikeAsk(f.last.text);
			const minutes = Math.floor((now - f.at) / 60_000);
			const dedupKey = keyOf(f);
			const text = `${asking ? "[ASKING] " : ""}thread "${clipTitle(f.title)}" on ${f.server} (threadId ${f.id}), idle ${minutes} min. Last message: ${excerptOf(f.last.text)}`;
			return { dedupKey, text, asking, at: f.at };
		})
		.sort((a, b) => Number(b.asking) - Number(a.asking) || a.at - b.at || (a.dedupKey < b.dedupKey ? -1 : 1));
	let fresh = 0;
	const out: Finding[] = [];
	for (const r of rows) {
		if (!open.has(r.dedupKey) && ++fresh > cfg.maxThreads) continue;
		out.push({ dedupKey: r.dedupKey, text: r.text });
	}
	const have = new Set(out.map((f) => f.dedupKey));
	for (const u of read.unreadable) {
		const stem = `${u.server}:${u.id}:`;
		for (const p of prior) if (p.dedupKey.startsWith(stem) && !have.has(p.dedupKey)) out.push({ ...p });
	}
	return out;
}

/** The check as an item source. `gather` reads the idle parents (the watchers do it); `prior` lists the source's open items. */
export function idleParentsSource(o: {
	cfg: IdleParentsConfig;
	gather: () => Promise<IdleParentsRead>;
	prior: () => PriorFinding[];
	now?: () => number;
}): ItemSource {
	return {
		name: IDLE_PARENTS_SOURCE,
		run: async () => idleParentFindings(await o.gather(), (o.now ?? Date.now)(), o.cfg, o.prior()),
	};
}

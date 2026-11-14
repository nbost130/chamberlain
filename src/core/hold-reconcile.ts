/**
 * The held-ledger reconciler: closes holds whose wait is over, so the ledger shows what still waits on the operator and
 * nothing else. Code only, no model. Two passes, both idempotent: a hold already closed is no longer open and is never
 * matched again.
 *
 *   1. Items (every tick, database only). A hold tied to a decision-queue item closes when that question is answered, on
 *      any path: the page, a batch, an answer wake, a direct relay, or the card in the backend. The match is the hold's
 *      structured `item` field alone, never its text. Nothing is remembered between runs, so a restart changes nothing.
 *   2. Refs (every ten minutes). A hold's structured `ref` names what it waits on: a PR or issue, a remote branch, a
 *      thread. The hold closes when the live state shows that thing is done, and the closure says what was seen. Only the
 *      structured fields are read, never the prose. Anything uncertain leaves the hold open: an API error, a malformed
 *      ref, an answer that does not say, a branch never seen to exist, a backend that cannot be read.
 *
 * GitHub calls are rate-aware: each distinct ref is looked up once per pass however many holds name it, at most
 * MAX_REQUESTS API requests per pass (every request counts, the repo-identity call too) (least recently checked first), and a rate-limit error stops the pass and backs off. Thread states
 * come from a fresh snapshot of each server taken in the pass (never the watchers' cache) and cost no GitHub calls. The engine is given the GitHub reader (core stays free of any one
 * host); tests pass fakes.
 */
import {
	cleanRef,
	closeHeldWhere,
	type Held,
	type HoldRef,
	heldOpen,
	isCardHold,
	itemIdOf,
	REF_SHAPES,
} from "./afk-held.ts";
import { type GhRead, type GitHubKind, lookup, type Seen, type Sighting } from "./hold-lookup.ts";
import { type MachineSnapshot, type ThreadView, threadViewAcross } from "./hold-threads.ts";
import { QUEUE, type QuestionState, questionStates } from "./questions.ts";
import type { Store } from "./store.ts";

/** How often the ref pass runs, and how many GitHub API requests it may spend (each request counts, not each ref). */
export const REF_PASS_MS = 10 * 60_000;
export const MAX_REQUESTS = 30;
/** After a rate-limit answer, no GitHub call is made for this long. */
export const BACKOFF_MS = 30 * 60_000;
const BY = "closed by the daemon's hold reconciler";
const STATE_KEY = "hold-reconcile";

/* ---------- pass 1: queue items ---------- */

/** How a settled question closed, in the words its holds are closed with, or undefined while it is open (a snoozed question is open). */
function answeredHow(store: Store, q: QuestionState | undefined): { t: string | undefined; how: string } | undefined {
	if (!q || q.status === "open") return undefined;
	const at = (t: string | undefined) => (t ? ` at ${t.slice(0, 16)}Z` : "");
	if (q.status === "answered-on-card") {
		const resolvedAt = store.items.get(QUEUE, q.id)?.resolvedAt;
		const t = resolvedAt ? new Date(resolvedAt).toISOString() : undefined;
		return { t, how: `Answered in its question card${at(t)}` };
	}
	if (q.status === "dismissed") return { t: q.dismissal?.t, how: `Dismissed on the queue${at(q.dismissal?.t)}` };
	const t = q.answer?.t;
	return { t, how: `Answered${q.answer ? ` "${q.answer.label}"` : ""} on the queue${at(t)}` };
}

/**
 * Close the holds of every answered or dismissed question (a snoozed one is still open, so its hold stays), by the hold's structured `item` field only. A hold with no `item` is never
 * closed by an answer, whatever its text names: it closes through its other refs, or by hand. A daemon's card hold is closed
 * here only once its pointer question was closed by the card itself (answered-on-card): an answer to the pointer leaves it open.
 */
export function reconcileItemHolds(store: Store, now = new Date()): { closed: number } {
	if (!heldOpen(store).length) return { closed: 0 };
	const qs = questionStates(store);
	const answered = (id: string) => answeredHow(store, qs.get(id));
	const closed = closeHeldWhere(
		store,
		(h) => {
			const id = itemIdOf(h);
			// A card hold closes only when its card resolves (the question then reads answered-on-card), never on an answer to its pointer.
			if (id && isCardHold(h) && qs.get(id)?.status !== "answered-on-card") return undefined;
			const a = id ? answered(id) : undefined;
			return a ? `${a.how} (item ${id}); ${BY}.` : undefined;
		},
		now,
	);
	return { closed };
}

/* ---------- pass 2: structured refs ---------- */

/** Fetched once per pass, and only when a hold names a thread. A rejection means every thread is unknown. */
export type ReconcileDeps = {
	store: Store;
	now?: number /** Undefined: GitHub refs are not checked. */;
	gh?: GhRead;
	snapshots?: () => Promise<MachineSnapshot[]>;
};
export type RefPassResult = {
	ran: boolean;
	closed: number /** Refs looked up. */;
	lookups: number /** GitHub API requests made: the budget is counted in these. */;
	requests: number;
	errors: number;
	backoff?: boolean;
};

type State = {
	lastPassAt?: number;
	backoffUntil?: number;
	checked?: Record<string, number> /** Branches seen to exist: one never seen is not one deleted. */;
	seenLive?: Record<string, Sighting>;
};

type Kind = "pr" | "issue" | "branch" | "thread";
const RATE = /rate limit|\b429\b|abuse|secondary/i;

/** The refs of one hold that the reconciler acts on: well-formed fields only. A card's thread is `ref.threadId`, or the hold's own card link. */
export function refsOf(h: Held): { kind: Kind; key: string; value: string; server?: string }[] {
	// A daemon's card hold waits on its card alone, and closes only with its pointer question (card-hold.ts closeCard): never through a ref.
	if (isCardHold(h)) return [];
	const r: HoldRef = cleanRef(h.ref) ?? {};
	const thread = r.threadId ?? (h.threadId && REF_SHAPES.threadId.test(h.threadId) ? h.threadId : undefined);
	/** The server the thread lives on, when the hold says: the only way a missing thread can count as gone. */
	const server = typeof h.server === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(h.server) ? h.server : undefined;
	return [
		...(r.pr ? [{ kind: "pr" as const, key: `pr:${r.pr}`, value: r.pr }] : []),
		...(r.issue ? [{ kind: "issue" as const, key: `issue:${r.issue}`, value: r.issue }] : []),
		...(r.branch ? [{ kind: "branch" as const, key: `branch:${r.branch}`, value: r.branch }] : []),
		...(thread
			? [
					{
						kind: "thread" as const,
						key: `thread:${server ?? ""}:${thread}`,
						value: thread,
						...(server ? { server } : {}),
					},
				]
			: []),
	];
}

type RefEntry = { kind: Kind; value: string; server?: string };
/** What one ref pass has found and spent so far. */
type Pass = {
	now: number;
	results: Map<string, Seen>;
	checked: Record<string, number>;
	seenLive: Record<string, Sighting>;
	lookups: number;
	requests: number;
	errors: number;
	backoff: boolean;
	backoffUntil: number | undefined;
};

/** The distinct refs of every open hold, by key. */
function openRefs(store: Store): Map<string, RefEntry> {
	const refs = new Map<string, RefEntry>();
	for (const h of heldOpen(store)) for (const r of refsOf(h)) refs.set(r.key, r);
	return refs;
}

/** What a thread's view means for its hold. */
function seenFromThread(v: ThreadView, value: string): Seen {
	return v.state === "live"
		? { state: "live" }
		: v.state === "unknown"
			? { state: "unknown", why: "thread not known" }
			: { state: "done", saw: `thread ${value} ${v.saw}` };
}

/** Threads: one fresh snapshot per server, fetched now. Nothing cached is consulted, and a failed fetch leaves every thread unknown. */
async function resolveThreads(pass: Pass, refs: Map<string, RefEntry>, snapshots: ReconcileDeps["snapshots"]) {
	const wantsThreads = [...refs.values()].some((r) => r.kind === "thread");
	let snaps: MachineSnapshot[] = [];
	if (wantsThreads && snapshots) {
		try {
			snaps = await snapshots();
		} catch {
			pass.errors++;
		}
	}
	for (const [key, r] of refs)
		if (r.kind === "thread") pass.results.set(key, seenFromThread(threadViewAcross(snaps, r.value, r.server), r.value));
}

/** A failed lookup is counted and leaves its hold open; a rate-limit answer also starts the back-off. */
function noteLookupFailure(pass: Pass, key: string, e: unknown) {
	pass.errors++;
	pass.results.set(key, { state: "unknown", why: `lookup failed: ${String(e).slice(0, 100)}` });
	if (RATE.test(String(e))) {
		pass.backoff = true;
		pass.backoffUntil = pass.now + BACKOFF_MS;
	}
}

/** A ref is looked up once however many holds name it; the least recently checked go first, so a cap never starves one. */
async function lookupRemote(pass: Pass, gh: GhRead | undefined, refs: Map<string, RefEntry>) {
	if (!gh) return;
	const remote = [...refs]
		.filter(([, r]) => r.kind !== "thread")
		.sort((a, b) => (pass.checked[a[0]] ?? 0) - (pass.checked[b[0]] ?? 0));
	/** Every call goes through here, so the budget counts requests actually made. */
	const counted: GhRead = (path, jq) => {
		pass.requests++;
		return gh(path, jq);
	};
	for (const [key, r] of remote) {
		// A branch costs two requests (repository identity, then the branch); a PR or an issue costs one. A ref that would
		// overspend waits for the next pass, and the least recently checked go first so none starves.
		if (pass.backoff || pass.requests + (r.kind === "branch" ? 2 : 1) > MAX_REQUESTS) break;
		pass.lookups++;
		pass.checked[key] = pass.now;
		try {
			pass.results.set(key, await lookup(r.kind as GitHubKind, r.value, counted, pass));
		} catch (e) {
			noteLookupFailure(pass, key, e);
		}
	}
}

/** Any one done ref closes its hold: each ref is the Steward's own statement of what the hold waits on. */
function closeDoneHolds(store: Store, results: Map<string, Seen>, now: number): number {
	return closeHeldWhere(
		store,
		(h) => {
			const done = refsOf(h)
				.map((r) => results.get(r.key))
				.find((s): s is Extract<Seen, { state: "done" }> => s?.state === "done");
			return done ? `${done.saw}; ${BY}.` : undefined;
		},
		new Date(now),
	);
}

/** Remembers the pass for the next one, keeping only what the open holds still name. */
function saveState(store: Store, pass: Pass, refs: Map<string, RefEntry>) {
	const keep = new Set(refs.keys());
	store.state.set(STATE_KEY, {
		lastPassAt: pass.now,
		...(pass.backoffUntil !== undefined && pass.backoffUntil > pass.now ? { backoffUntil: pass.backoffUntil } : {}),
		checked: Object.fromEntries(Object.entries(pass.checked).filter(([k]) => keep.has(k))),
		seenLive: Object.fromEntries(Object.entries(pass.seenLive).filter(([k]) => keep.has(`branch:${k}`))),
	} satisfies State);
}

/**
 * The ref pass. Throttled to one per REF_PASS_MS (the engine may call it every tick). Never throws on a failed lookup: it is
 * counted and leaves its holds open.
 */
export async function reconcileRefHolds(d: ReconcileDeps): Promise<RefPassResult> {
	const { store } = d;
	const now = d.now ?? Date.now();
	const st = store.state.get<State>(STATE_KEY) ?? {};
	if (st.lastPassAt !== undefined && now - st.lastPassAt < REF_PASS_MS)
		return { ran: false, closed: 0, lookups: 0, requests: 0, errors: 0 };
	const refs = openRefs(store);
	const pass: Pass = {
		now,
		results: new Map(),
		checked: st.checked ?? {},
		seenLive: { ...(st.seenLive ?? {}) },
		lookups: 0,
		requests: 0,
		errors: 0,
		backoff: st.backoffUntil !== undefined && now < st.backoffUntil,
		backoffUntil: st.backoffUntil,
	};
	await resolveThreads(pass, refs, d.snapshots);
	await lookupRemote(pass, d.gh, refs);
	const closed = closeDoneHolds(store, pass.results, now);
	saveState(store, pass, refs);
	const { lookups, requests, errors, backoff } = pass;
	return { ran: true, closed, lookups, requests, errors, ...(backoff ? { backoff: true } : {}) };
}

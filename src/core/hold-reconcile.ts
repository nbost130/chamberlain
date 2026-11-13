/**
 * The held-ledger reconciler: closes holds whose wait is over, so the ledger shows what still waits on the operator and
 * nothing else. Code only, no model. Two passes, both idempotent: a hold already closed is no longer open and is never
 * matched again.
 *
 *   1. Items (every tick, database only). A hold tied to a decision-queue item closes when that question is answered, on
 *      any path: the page, a batch, an answer wake, a direct relay, or the card in the backend. The match is afk.ts's own
 *      (the hold's `item` link, or the item ID standing as a word in its text). Nothing is remembered between runs, so
 *      a restart changes nothing.
 *   2. Refs (every ten minutes). A hold's structured `ref` names what it waits on: a PR or issue, a remote branch, a
 *      thread. The hold closes when the live state shows that thing is done, and the closure says what was seen. Only the
 *      structured fields are read, never the prose. Anything uncertain leaves the hold open: an API error, a malformed
 *      ref, an answer that does not say, a branch never seen to exist, a backend that cannot be read.
 *
 * GitHub calls are rate-aware: each distinct ref is looked up once per pass however many holds name it, at most
 * MAX_LOOKUPS per pass (least recently checked first), and a rate-limit error stops the pass and backs off. Thread states
 * come from a fresh snapshot of each server taken in the pass (never the watchers' cache) and cost no GitHub calls. The engine is given the GitHub reader (core stays free of any one
 * host); tests pass fakes.
 */
import { closeHeldWhere, cleanRef, heldOpen, itemIdsOf, REF_SHAPES, type Held, type HoldRef } from "./afk.ts";
import { QUEUE, questionStates } from "./questions.ts";
import type { Store } from "./store.ts";

/** How often the ref pass runs, and how many distinct GitHub lookups it may spend. */
export const REF_PASS_MS = 10 * 60_000;
export const MAX_LOOKUPS = 30;
/** After a rate-limit answer, no GitHub call is made for this long. */
export const BACKOFF_MS = 30 * 60_000;
const BY = "closed by the daemon's hold reconciler";
const STATE_KEY = "hold-reconcile";

/* ---------- pass 1: queue items ---------- */

/**
 * Close the holds of every answered question. A hold that only names an item in its text closes only when the answer
 * came after the hold was written: a newer hold that merely mentions an old, answered item is about something else.
 * When the answer's time cannot be read, a text-only match is not acted on.
 */
export function reconcileItemHolds(store: Store, now = new Date()): { closed: number } {
	if (!heldOpen(store).length) return { closed: 0 };
	const qs = questionStates(store);
	const answered = (id: string): { t: string | undefined; how: string } | undefined => {
		const q = qs.get(id);
		if (!q || q.status === "open") return undefined;
		const resolvedAt = store.items.get(QUEUE, id)?.resolvedAt;
		if (q.status === "answered-on-card") {
			const t = resolvedAt ? new Date(resolvedAt).toISOString() : undefined;
			return { t, how: `Answered in its card${t ? ` at ${t.slice(0, 16)}Z` : ""}` };
		}
		const t = q.answer?.t;
		return { t, how: `Answered${q.answer ? ` "${q.answer.label}"` : ""} on the queue${t ? ` at ${t.slice(0, 16)}Z` : ""}` };
	};
	const closed = closeHeldWhere(store, (h) => {
		for (const id of itemIdsOf(h)) {
			const a = answered(id);
			if (a && (h.item === id || (a.t !== undefined && a.t >= h.t))) return `${a.how} (item ${id}); ${BY}.`;
		}
		return undefined;
	}, now);
	return { closed };
}

/* ---------- pass 2: structured refs ---------- */

/** What a lookup learned. `live` means the thing is still going, so the hold stays. `unknown` stays too, and says why. */
export type Seen = { state: "done"; saw: string } | { state: "live" } | { state: "unknown"; why: string };
/** A GitHub read: the API path, a jq filter, the parsed result. Rejects on any failure. */
export type GhRead = (path: string, jq: string) => Promise<unknown>;
/** What a snapshot says of a thread: settled with nothing pending, archived or deleted, still live, or not known. */
export type ThreadView = { state: "settled" | "gone"; saw: string } | { state: "live" } | { state: "unknown" };
/** What a snapshot knows of one thread. */
export type ThreadFacts = { archived: boolean; settled: boolean; pendingRequestId: string | null; status: string };
/** Pure: a listed thread is gone when archived, settled when settled with no card or approval pending, and otherwise live. */
export const classifyThread = (t: ThreadFacts): ThreadView =>
	t.archived ? { state: "gone", saw: "archived" }
		: t.settled && !t.pendingRequestId && t.status !== "waiting" ? { state: "settled", saw: "settled" }
			: { state: "live" };
/**
 * One server's thread list, fetched in THIS pass over a connection of its own (`Adapter.snapshot`), never the cache the
 * watcher keeps. `healthy`: the server answered. `complete`: the answer was the whole list. A server that is offline,
 * unreachable, partial, or whose adapter cannot take a snapshot is not healthy and complete, and says nothing about any thread.
 */
export type MachineSnapshot = { machine: string; healthy: boolean; complete: boolean; get: (id: string) => ThreadFacts | undefined };
/**
 * Pure: a thread's state across servers. A healthy, complete snapshot that lists it decides. A thread no snapshot lists is
 * gone only when EVERY server gave a healthy, complete snapshot this pass; with any server offline or partial it may live
 * there, so it is unknown. Nothing else (a cache, a stream's last word) ever settles or removes a thread.
 */
export function threadViewAcross(snaps: MachineSnapshot[], id: string): ThreadView {
	const good = snaps.filter((s) => s.healthy && s.complete);
	for (const s of good) { const t = s.get(id); if (t) return classifyThread(t); }
	return snaps.length > 0 && good.length === snaps.length ? { state: "gone", saw: "gone from every server's fresh snapshot" } : { state: "unknown" };
}
/**
 * Fresh snapshots, one per server, each fetched now. A server whose fetch fails is reported unhealthy and says nothing; one
 * whose answer is marked partial is not complete. Never throws.
 */
export async function takeSnapshots(machines: { name: string; fetch: () => Promise<{ complete: boolean; threads: (ThreadFacts & { id: string })[] }> }[]): Promise<MachineSnapshot[]> {
	return Promise.all(machines.map(async (m): Promise<MachineSnapshot> => {
		try {
			const r = await m.fetch();
			if (!r.complete || !Array.isArray(r.threads)) return { machine: m.name, healthy: true, complete: false, get: () => undefined };
			const table = new Map<string, ThreadFacts>(r.threads.map((t) => [t.id, t]));
			return { machine: m.name, healthy: true, complete: true, get: (id) => table.get(id) };
		} catch {
			return { machine: m.name, healthy: false, complete: false, get: () => undefined };
		}
	}));
}
/** Fetched once per pass, and only when a hold names a thread. A rejection means every thread is unknown. */
export type ReconcileDeps = { store: Store; now?: number; /** Undefined: GitHub refs are not checked. */ gh?: GhRead; snapshots?: () => Promise<MachineSnapshot[]> };
export type RefPassResult = { ran: boolean; closed: number; lookups: number; errors: number; backoff?: boolean };

type State = { lastPassAt?: number; backoffUntil?: number; checked?: Record<string, number>; /** Branches seen to exist: one never seen is not one deleted. */ seenLive?: Record<string, { t: number; repoId: number }> };

type Kind = "pr" | "issue" | "branch" | "thread";
const RATE = /rate limit|\b429\b|abuse|secondary/i;
const stamp = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) ? `${v.slice(0, 16)}Z` : undefined);
const parts = (ref: string) => { const m = ref.match(/^([^/]+)\/([^#:]+)[#:](.+)$/); return m ? { owner: m[1]!, repo: m[2]!, tail: m[3]! } : undefined; };

/** The refs of one hold that the reconciler acts on: well-formed fields only. A card's thread is `ref.threadId`, or the hold's own card link. */
export function refsOf(h: Held): { kind: Kind; key: string; value: string }[] {
	const r: HoldRef = cleanRef(h.ref) ?? {};
	const thread = r.threadId ?? (h.threadId && REF_SHAPES.threadId.test(h.threadId) ? h.threadId : undefined);
	return [
		...(r.pr ? [{ kind: "pr" as const, key: `pr:${r.pr}`, value: r.pr }] : []),
		...(r.issue ? [{ kind: "issue" as const, key: `issue:${r.issue}`, value: r.issue }] : []),
		...(r.branch ? [{ kind: "branch" as const, key: `branch:${r.branch}`, value: r.branch }] : []),
		...(thread ? [{ kind: "thread" as const, key: `thread:${thread}`, value: thread }] : []),
	];
}

async function lookup(kind: "pr" | "issue" | "branch", value: string, gh: GhRead, seenLive: Record<string, { t: number; repoId: number }>, now: number): Promise<Seen> {
	const p = parts(value);
	if (!p) return { state: "unknown", why: "malformed ref" };
	const base = `repos/${p.owner}/${p.repo}`;
	if (kind === "pr") {
		const r = (await gh(`${base}/pulls/${p.tail}`, "{state:.state,merged_at:.merged_at,closed_at:.closed_at}")) as { state?: unknown; merged_at?: unknown; closed_at?: unknown } | null;
		if (r?.state === "open") return { state: "live" };
		if (r?.state === "closed") {
			const merged = stamp(r.merged_at);
			if (merged) return { state: "done", saw: `PR ${value} merged ${merged}` };
			const closed = stamp(r.closed_at);
			if (closed && !r.merged_at) return { state: "done", saw: `PR ${value} closed ${closed}` };
		}
		return { state: "unknown", why: "PR state not readable" };
	}
	if (kind === "issue") {
		const r = (await gh(`${base}/issues/${p.tail}`, "{state:.state,closed_at:.closed_at,pr:(.pull_request!=null)}")) as { state?: unknown; closed_at?: unknown; pr?: unknown } | null;
		if (r?.pr !== false) return { state: "unknown", why: "reference is a pull request or unreadable" };
		if (r.state === "open") return { state: "live" };
		const closed = stamp(r.closed_at);
		if (r.state === "closed" && closed) return { state: "done", saw: `issue ${value} closed ${closed}` };
		return { state: "unknown", why: "issue state not readable" };
	}
	// A branch is known deleted only on the same repository it was seen on. A slug can be transferred, renamed or recreated, so
	// the repository's numeric id is recorded when the branch is first seen, and an absent branch counts only when that same id
	// answers under the same name. A redirect (a different name back) or a different id is unknown, never deleted.
	const repo = (await gh(base, "{id:.id,full_name:.full_name}")) as { id?: unknown; full_name?: unknown } | null;
	if (typeof repo?.id !== "number" || !Number.isInteger(repo.id) || typeof repo.full_name !== "string") return { state: "unknown", why: "repository identity not readable" };
	if (repo.full_name.toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase()) return { state: "unknown", why: `repository now answers as ${repo.full_name}` };
	// matching-refs answers an empty list, not a 404, for a branch that is not there, so "gone" is never confused with "no access".
	const r = await gh(`${base}/git/matching-refs/heads/${p.tail}?per_page=100`, `[.[]|select(.ref==${JSON.stringify(`refs/heads/${p.tail}`)})]|length`);
	if (typeof r !== "number" || !Number.isInteger(r) || r < 0) return { state: "unknown", why: "branch answer not readable" };
	if (r > 0) { seenLive[value] = { t: now, repoId: repo.id }; return { state: "live" }; }
	const seen = seenLive[value];
	if (!seen || typeof seen.repoId !== "number") return { state: "unknown", why: "branch never seen on the remote, so not known to be deleted" };
	if (seen.repoId !== repo.id) return { state: "unknown", why: `repository id changed from ${seen.repoId} to ${repo.id}` };
	return { state: "done", saw: `branch ${value} no longer on the remote (repo id ${repo.id}, last seen ${new Date(seen.t).toISOString().slice(0, 16)}Z)` };
}

/**
 * The ref pass. Throttled to one per REF_PASS_MS (the engine may call it every tick). Never throws on a failed lookup: it is
 * counted and leaves its holds open.
 */
export async function reconcileRefHolds(d: ReconcileDeps): Promise<RefPassResult> {
	const { store } = d;
	const now = d.now ?? Date.now();
	const st = store.state.get<State>(STATE_KEY) ?? {};
	if (st.lastPassAt !== undefined && now - st.lastPassAt < REF_PASS_MS) return { ran: false, closed: 0, lookups: 0, errors: 0 };
	const refs = new Map<string, { kind: Kind; value: string }>();
	for (const h of heldOpen(store)) for (const r of refsOf(h)) refs.set(r.key, r);
	const checked = st.checked ?? {};
	const seenLive = { ...(st.seenLive ?? {}) };
	const results = new Map<string, Seen>();
	let lookups = 0;
	let errors = 0;
	let backoff = st.backoffUntil !== undefined && now < st.backoffUntil;
	let backoffUntil = st.backoffUntil;

	// Threads: one fresh snapshot per server, fetched now. Nothing cached is consulted, and a failed fetch leaves every thread unknown.
	const wantsThreads = [...refs.values()].some((r) => r.kind === "thread");
	let snaps: MachineSnapshot[] = [];
	if (wantsThreads && d.snapshots) { try { snaps = await d.snapshots(); } catch { errors++; } }
	for (const [key, r] of refs) if (r.kind === "thread") {
		const v = threadViewAcross(snaps, r.value);
		results.set(key, v.state === "live" ? { state: "live" } : v.state === "unknown" ? { state: "unknown", why: "thread not known" } : { state: "done", saw: `thread ${r.value} ${v.saw}` });
	}
	// A ref is looked up once however many holds name it; the least recently checked go first, so a cap never starves one.
	const remote = d.gh ? [...refs].filter(([, r]) => r.kind !== "thread").sort((a, b) => (checked[a[0]] ?? 0) - (checked[b[0]] ?? 0)) : [];
	for (const [key, r] of remote) {
		if (backoff || lookups >= MAX_LOOKUPS) break;
		lookups++;
		checked[key] = now;
		try {
			results.set(key, await lookup(r.kind as "pr" | "issue" | "branch", r.value, d.gh!, seenLive, now));
		} catch (e) {
			errors++;
			results.set(key, { state: "unknown", why: `lookup failed: ${String(e).slice(0, 100)}` });
			if (RATE.test(String(e))) { backoff = true; backoffUntil = now + BACKOFF_MS; }
		}
	}
	// Any one done ref closes its hold: each ref is the Steward's own statement of what the hold waits on.
	const closed = closeHeldWhere(store, (h) => {
		const done = refsOf(h).map((r) => results.get(r.key)).find((s): s is Extract<Seen, { state: "done" }> => s?.state === "done");
		return done ? `${done.saw}; ${BY}.` : undefined;
	}, new Date(now));
	const keep = new Set(refs.keys());
	store.state.set(STATE_KEY, {
		lastPassAt: now,
		...(backoffUntil !== undefined && backoffUntil > now ? { backoffUntil } : {}),
		checked: Object.fromEntries(Object.entries(checked).filter(([k]) => keep.has(k))),
		seenLive: Object.fromEntries(Object.entries(seenLive).filter(([k]) => keep.has(`branch:${k}`))),
	} satisfies State);
	return { ran: true, closed, lookups, errors, ...(backoff ? { backoff: true } : {}) };
}

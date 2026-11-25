/**
 * The once-a-minute check of the Steward's own thread: keep it out of its own wakes, keep the rights high-water mark, raise the stall and
 * unreadable-queue alarms, and compact it when its context has outgrown the limit. Split out of createEngine (src/core/engine/engine.ts), which passes
 * it the few things it reads and writes.
 */
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
import { effectiveLimits } from "../config/context-guard.ts";
import { needsCompact, rightsLost } from "../decide/decide.ts";
import type { WakeResult } from "../delivery/deliver.ts";
import type { Log } from "../log.ts";
import { type AlarmText, alarms } from "../messages.ts";
import { redactUrls } from "../redact.ts";
import { type openRightsSent, rightsHighWater } from "../steward/rights-sent.ts";

const QUEUE_READ_FAILURES_MAX = 5;
const COMPACT_COOLDOWN_MS = 10 * 60_000;
/** An accepted compaction that never ran (no completed compaction counted, none queued or blocked) this long after is taken as lost, and may be sent again. */
const COMPACT_LOST_AFTER_MS = 30 * 60_000;

type CompactionDeps = {
	compactReady: () => boolean;
	compact: (deliveryId: string) => Promise<WakeResult>;
	log: Log;
	raiseAlarm: (key: string, a: AlarmText) => void;
	dry: boolean;
	compactAt: number;
	compactState: { get: () => CompactState | undefined; set: (s: CompactState) => void };
};

export type StewardCheckDeps = CompactionDeps & {
	/** A private file in the config directory, or undefined. */
	privateFile: (name: string) => string | undefined;
	/** Threads the engine never wakes about: the Steward's own joins it. */
	exclude: Set<string>;
	/** The home adapter's read of the Steward, or undefined when it has none. */
	probe: () => StewardProbe | undefined;
	rightsSent: ReturnType<typeof openRightsSent>;
	alarm: (key: string, title: string, summary: string) => void;
	compactShare?: number;
	/** Runs the fallback policy even if no size was read. Returns true when compaction cannot help. */
	fallback?: (id: string, p: StewardProbe, compactAt: number) => boolean;
	/** Told, each minute, which thread is the pinned Decisions thread. */
	onDecisionsThread: (id: string | undefined) => void;
};

/** What the check remembers from one minute to the next. */
type StewardState = {
	compactHeldFor: string | undefined;
	queueReadFailures: number;
	/** When a compaction was last tried (sent, refused, not ready, or dry): the normal cooldown, so a refused POST retries on the next tick after it, not every minute. */
	attemptAt: number | undefined;
};

/**
 * The last compaction T3 ACCEPTED (a refused or failed POST, a Steward not ready, and a dry run record nothing), kept in the database (state key
 * `steward-compact`) so a restart does not forget it. `compactions` is how many had completed when it was sent. `cleared` is whether the context
 * has been seen at or under the line since; `failed` is that the compaction RAN (a later one is counted, and the context was measured at or after
 * it) and the context is still over the line: compacting again would only repeat it, so the health check says HAND OFF (`compactFailed`). It is
 * cleared again when the context is back under the line.
 */
export type CompactState = {
	thread: string;
	session?: string;
	at: number;
	used: number;
	cleared: boolean;
	failed?: boolean;
	unsupported?: boolean;
	compactions?: number;
	/** How many times this compaction has been sent again because it never ran: at most one, then it is called failed. */
	resends?: number;
};
export const COMPACT_STATE_KEY = "steward-compact";

/**
 * Keeps the high-water mark every minute: compared only to the last wake's size, a compaction could go unseen. A shrink invalidates the
 * record by bumping the epoch, so a full block composed before it cannot restore the record when it lands.
 */
function keepRightsMark(c: StewardCheckDeps, p: StewardProbe): void {
	const sent = c.rightsSent.get(),
		high = rightsHighWater(sent, p.contextTokens, p.compactions);
	if (high) c.rightsSent.set(high);
	else if (sent) {
		const lost = rightsLost(sent, { used: p.contextTokens, compactions: p.compactions });
		c.rightsSent.set(undefined);
		c.log("rights-invalidated", {
			reason: lost === "compaction" ? "compaction" : "context shrink",
			used: p.contextTokens,
		});
	}
}

/**
 * A 202 only means queued. This is the check that the Steward is actually working through them.
 * One failed read is the backend busy. A run of them means both checks here can no longer see, and that must not be silent.
 */
function watchSteward(c: StewardCheckDeps, st: StewardState, p: StewardProbe): void {
	st.queueReadFailures = p.readable ? 0 : st.queueReadFailures + 1;
	if (st.queueReadFailures >= QUEUE_READ_FAILURES_MAX)
		c.raiseAlarm("steward-queue-unreadable", alarms.queueUnreadable(st.queueReadFailures));
	if (p.stalled) c.alarm("steward-stalled", p.stalled.title, p.stalled.summary);
}

/** The compaction request, through the relay: a task whose prompt is /compact, so it takes no message. True when T3 accepted it. Only the log line is shared with wakes. */
async function sendCompact(c: CompactionDeps, id: string): Promise<"accepted" | "unsupported" | "refused"> {
	const deliveryId = `compact:${id}:${Date.now()}`;
	try {
		const r = await c.compact(deliveryId);
		if (r.ok) {
			c.log("delivered", { deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: 1 });
			return "accepted";
		}
		c.log("deliver-error", {
			deliveryId,
			attempt: 1,
			...(r.status !== undefined ? { http: r.status } : {}),
			...(r.error ? { error: redactUrls(r.error) } : {}),
		});
		if (r.prepareReason === "unsupported") return "unsupported";
	} catch (e) {
		c.log("deliver-error", {
			deliveryId,
			attempt: 1,
			error: redactUrls(e instanceof Error ? e.message : String(e)),
		});
	}
	return "refused";
}

/**
 * The last accepted compaction for THIS Steward thread, after noting whether the context is back under the line (a compaction that worked
 * leaves it there, and that also ends a `failed` verdict; a new Steward thread starts clean).
 */
function lastCompaction(c: CompactionDeps, p: StewardProbe, id: string): CompactState | undefined {
	const last = c.compactState.get();
	if (!last || last.thread !== id || (last.session !== undefined && last.session !== p.contextSession))
		return undefined;
	if (
		!p.contextPending &&
		p.contextTokens !== undefined &&
		p.contextTokens <= c.compactAt &&
		(!last.cleared || last.failed)
	) {
		const { failed: _failed, unsupported: _unsupported, ...rest } = last;
		const next = { ...rest, cleared: true };
		c.compactState.set(next);
		return next;
	}
	return last;
}

/** Marks the last compaction failed (once, logged): compacting again would only repeat it, and the health check says HAND OFF. */
function failCompaction(c: CompactionDeps, p: StewardProbe, last: CompactState, id: string): "ineffective" {
	if (!last.failed) {
		c.compactState.set({ ...last, failed: true });
		c.log("compact-ineffective", { threadId: id, used: p.contextTokens, was: last.used });
	}
	return "ineffective";
}

/**
 * Whether the last accepted compaction can be called a failure, is still on its way, or was lost. It FAILED when it has actually run (a
 * completed compaction is counted since it was sent, and the context was measured at or after that compaction's turn) with none queued or
 * blocked and the context still over the line. Otherwise it is pending, until nothing has been seen of it for half an hour with nothing queued.
 * Then, if the compaction count can be read, it is lost and is sent again, ONCE; a second one that never ran is a failure. If the count cannot
 * be read an unseen compaction is not a lost one: the context size judges instead, and it is still over the line, so it is a failure, never a re-send.
 */
function judgeLast(
	c: CompactionDeps,
	p: StewardProbe,
	last: CompactState,
	id: string,
): "pending" | "ineffective" | "lost" {
	const readable = p.compactions !== undefined && last.compactions !== undefined;
	const ran = readable && (p.compactions as number) > (last.compactions as number);
	const measured =
		!p.contextPending &&
		p.contextTokens !== undefined &&
		p.contextTokens > c.compactAt &&
		p.contextTurn !== undefined &&
		p.compactionTurn !== undefined &&
		p.contextTurn >= p.compactionTurn;
	if (ran && measured && p.compactBlocked === undefined) return failCompaction(c, p, last, id);
	const aged = !ran && p.compactBlocked === undefined && Date.now() - last.at >= COMPACT_LOST_AFTER_MS;
	if (!aged) return "pending";
	return !readable || !mayResend(p, last) ? failCompaction(c, p, last, id) : "lost";
}

const mayResend = (p: StewardProbe, last: CompactState) => p.retryLostCompact !== false && (last.resends ?? 0) < 1;

/** Compacts the Steward `id` when its context has outgrown the limit, unless one went in the cooldown or the backend says one must not go now. */
async function compactIfNeeded(c: CompactionDeps, st: CompactMemory, p: StewardProbe, id: string): Promise<void> {
	const used = p.contextPending ? undefined : p.contextTokens;
	const last = lastCompaction(c, p, id);
	const lost = last && !last.cleared ? last : undefined;
	if (used === undefined) {
		if (lost && !lost.failed && p.retryLostCompact === false) judgeLast(c, p, lost, id);
		return;
	}
	const since = (t: number | undefined) => t !== undefined && Date.now() - t < COMPACT_COOLDOWN_MS;
	if (!needsCompact(used, c.compactAt, since(st.attemptAt) || since(last?.at))) return;
	if (lost?.failed) return;
	if (lost && judgeLast(c, p, lost, id) !== "lost") return;
	if (heldForCompaction(c.log, st, p.compactBlocked)) return;
	st.attemptAt = Date.now();
	if (!c.compactReady()) {
		c.raiseAlarm("steward-compact", alarms.compactUnavailable(used));
		return;
	}
	// The rights record is invalidated by the relay, inside the compaction's serial job and once T3 has accepted the request (relay.ts, `compact`).
	c.log("fire", { server: "steward", kind: "compact", threadId: id, used });
	if (c.dry) return;
	// The request goes out through the relay, the only code that calls a transport. It is recorded only once T3 has accepted it.
	await recordCompactAttempt(c, p, id, lost);
}

async function recordCompactAttempt(c: CompactionDeps, p: StewardProbe, id: string, lost: CompactState | undefined) {
	const result = await sendCompact(c, id);
	if (result === "refused") return;
	const state = acceptedCompaction(p, id, lost);
	c.compactState.set(result === "unsupported" ? { ...state, failed: true, unsupported: true } : state);
}

type CompactMemory = Pick<StewardState, "compactHeldFor" | "attemptAt">;

function heldForCompaction(log: Log, memory: CompactMemory, blocked: string | undefined): boolean {
	if (blocked !== memory.compactHeldFor) log(blocked ? "skip-compact" : "compact-clear", { reason: blocked });
	memory.compactHeldFor = blocked;
	return blocked !== undefined;
}

export function createCompactionCheck(c: CompactionDeps) {
	const memory: CompactMemory = { compactHeldFor: undefined, attemptAt: undefined };
	return (p: StewardProbe, id: string, compactAt: number) => compactIfNeeded({ ...c, compactAt }, memory, p, id);
}

/** The record of a compaction T3 accepted: the size and the completed-compaction count then, and how often it has been sent again. */
function acceptedCompaction(p: StewardProbe, id: string, lost: CompactState | undefined): CompactState {
	return {
		thread: id,
		...(p.contextSession ? { session: p.contextSession } : {}),
		at: Date.now(),
		used: p.contextTokens ?? 0,
		cleared: false,
		...(p.compactions !== undefined ? { compactions: p.compactions } : {}),
		...(lost ? { resends: (lost.resends ?? 0) + 1 } : {}),
	};
}

export function createStewardCheck(c: StewardCheckDeps) {
	const st: StewardState = { compactHeldFor: undefined, queueReadFailures: 0, attemptAt: undefined };
	const compact = createCompactionCheck(c);
	/** Once a minute: keep the Steward out of its own wakes, and compact it when its context has outgrown the limit. */
	async function stewardCheck() {
		c.onDecisionsThread(c.privateFile("decisions-thread"));
		const id = c.privateFile("steward-thread");
		if (!id) return;
		c.exclude.add(id);
		const p = c.probe();
		if (!p) return;
		keepRightsMark(c, p);
		watchSteward(c, st, p);
		const window = p.context && "tokens" in p.context ? p.context.window : undefined;
		const { compactAt } = effectiveLimits(
			{ compactAt: c.compactAt, watchAt: c.compactAt, share: c.compactShare },
			window,
		);
		if (!c.fallback?.(id, p, compactAt)) await compact(p, id, compactAt);
	}

	return { check: stewardCheck };
}

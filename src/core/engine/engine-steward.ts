/**
 * The once-a-minute check of the Steward's own thread: keep it out of its own wakes, keep the rights high-water mark, raise the stall and
 * unreadable-queue alarms, and compact it when its context has outgrown the limit. Split out of createEngine (src/core/engine/engine.ts), which passes
 * it the few things it reads and writes.
 */
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
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

export type StewardCheckDeps = {
	/** A private file in the config directory, or undefined. */
	privateFile: (name: string) => string | undefined;
	/** Threads the engine never wakes about: the Steward's own joins it. */
	exclude: Set<string>;
	/** The home adapter's read of the Steward, or undefined when it has none. */
	probe: () => StewardProbe | undefined;
	rightsSent: ReturnType<typeof openRightsSent>;
	/** Whether a compaction target is configured, and the relay's compaction (the relay is the one code that calls a wake transport). */
	compactReady: () => boolean;
	/** The relay's compaction attempt: carries `ok` and a sanitized `error`, not only HTTP status. */
	compact: (deliveryId: string) => Promise<WakeResult>;
	log: Log;
	alarm: (key: string, title: string, summary: string) => void;
	raiseAlarm: (key: string, a: AlarmText) => void;
	dry: boolean;
	/** The Steward's context size, in tokens, past which it is compacted. */
	compactAt: number;
	/** The last compaction asked for (`CompactState`), durable. */
	compactState: { get: () => CompactState | undefined; set: (s: CompactState) => void };
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
	at: number;
	used: number;
	cleared: boolean;
	failed?: boolean;
	compactions?: number;
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
async function sendCompact(c: StewardCheckDeps, id: string): Promise<boolean> {
	const deliveryId = `compact:${id}:${Date.now()}`;
	try {
		const r = await c.compact(deliveryId);
		if (r.ok) {
			c.log("delivered", { deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: 1 });
			return true;
		}
		c.log("deliver-error", {
			deliveryId,
			attempt: 1,
			...(r.status !== undefined ? { http: r.status } : {}),
			...(r.error ? { error: redactUrls(r.error) } : {}),
		});
	} catch (e) {
		c.log("deliver-error", {
			deliveryId,
			attempt: 1,
			error: redactUrls(e instanceof Error ? e.message : String(e)),
		});
	}
	return false;
}

/**
 * The last accepted compaction for THIS Steward thread, after noting whether the context is back under the line (a compaction that worked
 * leaves it there, and that also ends a `failed` verdict; a new Steward thread starts clean).
 */
function lastCompaction(c: StewardCheckDeps, p: StewardProbe, id: string): CompactState | undefined {
	const last = c.compactState.get();
	if (!last || last.thread !== id) return undefined;
	if (p.contextTokens !== undefined && p.contextTokens <= c.compactAt && (!last.cleared || last.failed)) {
		const { failed: _failed, ...rest } = last;
		const next = { ...rest, cleared: true };
		c.compactState.set(next);
		return next;
	}
	return last;
}

/**
 * Whether the last accepted compaction can be called a failure, is still on its way, or was lost. It FAILED only when it has actually run (a
 * completed compaction is counted since it was sent, and the context was measured at or after that compaction's turn) with none queued or
 * blocked and the context still over the line. Otherwise it is pending (queued behind a long turn, or run but not yet measured), until nothing
 * has been seen of it for half an hour and nothing is queued: lost, and sent again.
 */
function judgeLast(
	c: StewardCheckDeps,
	p: StewardProbe,
	last: CompactState,
	id: string,
): "pending" | "ineffective" | "lost" {
	const ran = p.compactions !== undefined && last.compactions !== undefined && p.compactions > last.compactions;
	const measured = p.contextTurn !== undefined && p.compactionTurn !== undefined && p.contextTurn >= p.compactionTurn;
	if (ran && measured && p.compactBlocked === undefined) {
		if (!last.failed) {
			c.compactState.set({ ...last, failed: true });
			c.log("compact-ineffective", { threadId: id, used: p.contextTokens, was: last.used });
		}
		return "ineffective";
	}
	return !ran && p.compactBlocked === undefined && Date.now() - last.at >= COMPACT_LOST_AFTER_MS ? "lost" : "pending";
}

/** Compacts the Steward `id` when its context has outgrown the limit, unless one went in the cooldown or the backend says one must not go now. */
async function compactIfNeeded(c: StewardCheckDeps, st: StewardState, p: StewardProbe, id: string): Promise<void> {
	const used = p.contextTokens;
	const last = lastCompaction(c, p, id);
	const since = (t: number | undefined) => t !== undefined && Date.now() - t < COMPACT_COOLDOWN_MS;
	if (!needsCompact(used, c.compactAt, since(st.attemptAt) || since(last?.at))) return;
	if (last && !last.cleared && judgeLast(c, p, last, id) !== "lost") return;
	const blocked = p.compactBlocked;
	if (blocked !== st.compactHeldFor) c.log(blocked ? "skip-compact" : "compact-clear", { reason: blocked });
	st.compactHeldFor = blocked;
	if (blocked) return;
	st.attemptAt = Date.now();
	if (!c.compactReady()) {
		c.raiseAlarm("steward-compact", alarms.compactUnavailable(used));
		return;
	}
	// The rights record is invalidated by the relay, inside the compaction's serial job and before its POST (relay.ts, `compact`): clearing it
	// here, before the job runs, let a full block already in flight land after and restore it.
	c.log("fire", { server: "steward", kind: "compact", threadId: id, used });
	if (c.dry) return;
	// The request goes out through the relay, the only code that calls a transport. It is recorded only once T3 has accepted it.
	if (await sendCompact(c, id))
		c.compactState.set({
			thread: id,
			at: Date.now(),
			used: used ?? 0,
			cleared: false,
			...(p.compactions !== undefined ? { compactions: p.compactions } : {}),
		});
}

export function createStewardCheck(c: StewardCheckDeps) {
	const st: StewardState = { compactHeldFor: undefined, queueReadFailures: 0, attemptAt: undefined };
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
		await compactIfNeeded(c, st, p, id);
	}

	return { check: stewardCheck };
}

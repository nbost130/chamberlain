/**
 * The once-a-minute check of the Steward's own thread: keep it out of its own wakes, keep the rights high-water mark, raise the stall and
 * unreadable-queue alarms, and compact it when its context has outgrown the limit. Split out of createEngine (src/core/engine.ts), which passes
 * it the few things it reads and writes.
 */
import type { StewardProbe } from "./adapter-inspect.ts";
import { needsCompact } from "./decide.ts";
import type { Log } from "./log.ts";
import { type AlarmText, alarms } from "./messages.ts";
import { type openRightsSent, rightsHighWater } from "./rights-sent.ts";

const QUEUE_READ_FAILURES_MAX = 5;
const COMPACT_COOLDOWN_MS = 10 * 60_000;

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
	compact: (deliveryId: string) => Promise<{ status?: number }>;
	log: Log;
	alarm: (key: string, title: string, summary: string) => void;
	raiseAlarm: (key: string, a: AlarmText) => void;
	dry: boolean;
	/** The Steward's context size, in tokens, past which it is compacted. */
	compactAt: number;
	/** Told, each minute, which thread is the pinned Decisions thread. */
	onDecisionsThread: (id: string | undefined) => void;
};

/** What the check remembers from one minute to the next. */
type StewardState = { lastCompactAt: number; compactHeldFor: string | undefined; queueReadFailures: number };

/**
 * Keeps the high-water mark every minute: compared only to the last wake's size, a compaction could go unseen. A shrink invalidates the
 * record by bumping the epoch, so a full block composed before it cannot restore the record when it lands.
 */
function keepRightsMark(c: StewardCheckDeps, used: number | undefined): void {
	const sent = c.rightsSent.get(),
		high = rightsHighWater(sent, used);
	if (high) c.rightsSent.set(high);
	else if (sent) {
		c.rightsSent.set(undefined);
		c.log("rights-invalidated", { reason: "context shrink", used });
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

/** The compaction request, through the relay: a task whose prompt is /compact, so it takes no message. Only the log line is shared with wakes. */
async function sendCompact(c: StewardCheckDeps, id: string): Promise<void> {
	const deliveryId = `compact:${id}:${Date.now()}`;
	try {
		const r = await c.compact(deliveryId);
		c.log("delivered", { deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: 1 });
	} catch (e) {
		c.log("deliver-error", { deliveryId, attempt: 1, error: e instanceof Error ? e.message : String(e) });
	}
}

/** Compacts the Steward `id` when its context has outgrown the limit, unless one went in the cooldown or the backend says one must not go now. */
async function compactIfNeeded(c: StewardCheckDeps, st: StewardState, p: StewardProbe, id: string): Promise<void> {
	const used = p.contextTokens;
	if (!needsCompact(used, c.compactAt, Date.now() - st.lastCompactAt < COMPACT_COOLDOWN_MS)) return;
	const blocked = p.compactBlocked;
	if (blocked !== st.compactHeldFor) c.log(blocked ? "skip-compact" : "compact-clear", { reason: blocked });
	st.compactHeldFor = blocked;
	if (blocked) return;
	st.lastCompactAt = Date.now();
	if (!c.compactReady()) {
		c.raiseAlarm("steward-compact", alarms.compactUnavailable(used));
		return;
	}
	// The rights record is invalidated by the relay, inside the compaction's serial job and before its POST (relay.ts, `compact`): clearing it
	// here, before the job runs, let a full block already in flight land after and restore it.
	c.log("fire", { server: "steward", kind: "compact", threadId: id, used });
	if (c.dry) return;
	// The request goes out through the relay, the only code that calls a transport.
	await sendCompact(c, id);
}

export function createStewardCheck(c: StewardCheckDeps) {
	const st: StewardState = { lastCompactAt: 0, compactHeldFor: undefined, queueReadFailures: 0 };
	/** Once a minute: keep the Steward out of its own wakes, and compact it when its context has outgrown the limit. */
	async function stewardCheck() {
		c.onDecisionsThread(c.privateFile("decisions-thread"));
		const id = c.privateFile("steward-thread");
		if (!id) return;
		c.exclude.add(id);
		const p = c.probe();
		if (!p) return;
		keepRightsMark(c, p.contextTokens);
		watchSteward(c, st, p);
		await compactIfNeeded(c, st, p, id);
	}

	return { check: stewardCheck };
}

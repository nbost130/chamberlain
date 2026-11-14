/**
 * The once-a-minute check of the Steward's own thread: keep it out of its own wakes, keep the rights high-water mark, raise the stall and
 * unreadable-queue alarms, and compact it when its context has outgrown the limit. Split out of createEngine (src/core/engine.ts), which passes
 * it the few things it reads and writes.
 */
import type { StewardProbe } from "./adapter.ts";
import { needsCompact } from "./decide.ts";
import type { Log } from "./log.ts";
import { alarms, type AlarmText } from "./messages.ts";
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

export function createStewardCheck(c: StewardCheckDeps) {
	const { privateFile, exclude, probe, rightsSent, log, alarm, raiseAlarm, compactAt, onDecisionsThread } = c;
	const DRY = c.dry;
	/** Once a minute: keep the Steward out of its own wakes, and compact it when its context has outgrown the limit. */
	let lastCompactAt = 0;
	let compactHeldFor: string | undefined;
	let queueReadFailures = 0;
	async function stewardCheck() {
		onDecisionsThread(privateFile("decisions-thread"));
		const id = privateFile("steward-thread");
		if (!id) return;
		exclude.add(id);
		const p = probe();
		if (!p) return;
		const used = p.contextTokens;
		// Keep the high-water mark every minute: compared only to the last wake's size, a compaction could go unseen. A shrink invalidates the
		// record by bumping the epoch, so a full block composed before it cannot restore the record when it lands.
		const sent = rightsSent.get(), high = rightsHighWater(sent, used);
		if (high) rightsSent.set(high);
		else if (sent) { rightsSent.set(undefined); log("rights-invalidated", { reason: "context shrink", used }); }
		// A 202 only means queued. This is the check that the Steward is actually working through them.
		// One failed read is the backend busy. A run of them means both checks here can no longer see, and that must not be silent.
		queueReadFailures = p.readable ? 0 : queueReadFailures + 1;
		if (queueReadFailures >= QUEUE_READ_FAILURES_MAX) raiseAlarm("steward-queue-unreadable", alarms.queueUnreadable(queueReadFailures));
		if (p.stalled) alarm("steward-stalled", p.stalled.title, p.stalled.summary);
		if (!needsCompact(used, compactAt, Date.now() - lastCompactAt < COMPACT_COOLDOWN_MS)) return;
		const blocked = p.compactBlocked;
		if (blocked !== compactHeldFor) log(blocked ? "skip-compact" : "compact-clear", { reason: blocked });
		compactHeldFor = blocked;
		if (blocked) return;
		lastCompactAt = Date.now();
		if (!c.compactReady()) { raiseAlarm("steward-compact", alarms.compactUnavailable(used)); return; }
		// The rights record is invalidated by the relay, inside the compaction's serial job and before its POST (relay.ts, `compact`): clearing it
		// here, before the job runs, let a full block already in flight land after and restore it.
		log("fire", { server: "steward", kind: "compact", threadId: id, used });
		if (DRY) return;
		// The compaction target is a task whose prompt is /compact, so it takes no message. Only the log line is shared with wakes. The request goes out through the relay, the only code that calls a transport.
		const deliveryId = `compact:${id}:${Date.now()}`;
		try { const r = await c.compact(deliveryId); log("delivered", { deliveryId, ...(r.status !== undefined ? { http: r.status } : {}), attempt: 1 }); } catch (e) { log("deliver-error", { deliveryId, attempt: 1, error: e instanceof Error ? e.message : String(e) }); }
	}

	return { check: stewardCheck };
}

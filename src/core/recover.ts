/**
 * Stalled-thread recovery: a failed run is read in code, retried once after a grace by the daemon itself, and handed to a
 * judge only when the retry fails too. A model never decides whether to retry, and a person is woken only when the code cannot
 * settle it.
 *
 *   1. Classify the failure (`classifyFailure`, a table in code). Retry only: stream closed, rate limit (after 15 minutes),
 *      capacity, provider turn failed, out of memory. Never auth, Cloudflare, a safety block, quota, workspace or git errors,
 *      or anything the table does not know.
 *   2. Never retry a thread that is waiting (an open card, a hand-back to the principal, children running, a watch or gate
 *      parked), the Steward's thread, the Decisions thread, or a run someone interrupted (`neverRetryThread`).
 *   3. Retry once, after a 3-minute grace, through the one ping (src/adapters/t3/ping.ts, as the daemon). If anyone wrote in the
 *      thread, started a run on it, or it is no longer failed when the grace ends, stand down: someone is handling it. The thread
 *      is read from the backend again right before the ping (`look`), and the ping itself refuses a thread that is active or waiting.
 *   4. A second failure of a thread after its retry, at any time within the horizon (six hours of unhealthy running), goes to the judge (src/core/judge.ts, per trigger). The verdict goes to
 *      the Steward as a wake, and to the principal through the decision queue when the judge says the principal is needed. The
 *      daemon retries that thread no more until it completes a turn.
 *   5. Outage breaker: three failures of one kind within ten minutes (any threads) stop every retry and raise ONE alarm to the
 *      principal through the decision queue. It stays tripped until ten minutes pass with no failure.
 *
 * Known limit (documented, not fixed): the retry is queued behind whatever is pending (queue mode), and a queued retry has no expiry, so on a
 * thread that stays busy it runs whenever the thread next frees up, however late.
 *
 * The retry never changes the model. A capacity failure is retried on the same model; whether to try another is the principal's call.
 *
 * Recovery state (per-thread failures, pings sent, judged hold, pending retries, the breaker) is persisted through a RecoverStore, so
 * a restart neither forgets a retry already sent (it would send a second first ping) nor a judge's hold. A pending retry is re-armed
 * on `restore()`. Without a store the state is in memory only.
 */
import type { ThreadState } from "./adapter.ts";
import { DEFAULT_RECOVER_TIMING, type FailureKind, MIN, type RecoverTiming } from "./recover-classify.ts";
import { arm, clearPending, clockTimer, type Env, save, tripped } from "./recover-env.ts";
import { onFailure } from "./recover-run.ts";
import { freshState, type Handling, memoryRecoverStore, type RecoverDeps } from "./recover-state.ts";

export function createRecovery(d: RecoverDeps) {
	const store = d.store ?? memoryRecoverStore();
	const rc: Env = {
		d,
		now: d.now ?? Date.now,
		t: { ...DEFAULT_RECOVER_TIMING, ...d.timing },
		timer: d.setTimer ?? clockTimer,
		store,
		st: store.load() ?? freshState(),
		timers: new Map<string, () => void>(),
	};
	return {
		onFailure: (thread: ThreadState) => onFailure(rc, thread),
		/** After a restart: re-arms every retry that was pending, each no sooner than `restoreDelayMs` (the watchers need a moment to see the threads). */
		restore() {
			for (const [id, r] of Object.entries(rc.st.threads))
				if (r.pending) {
					arm(rc, id, Math.max(r.pending.due - rc.now(), rc.t.restoreDelayMs));
					d.log("recover-restored", { threadId: id, runId: r.pending.runId });
				}
		},
		/** A thread completed a turn without failing: it is healthy again, so its record, and the judge's hold, end. */
		healthy(threadId: string) {
			clearPending(rc, threadId);
			if (rc.st.threads[threadId]) {
				delete rc.st.threads[threadId];
				save(rc);
			}
		},
		/** Someone started a run on the thread: a pending retry is no longer needed. */
		moved(threadId: string) {
			const p = rc.st.threads[threadId]?.pending;
			if (p) {
				clearPending(rc, threadId);
				save(rc);
				d.log("recover-stand-down", { threadId, runId: p.runId, kind: p.kind, why: "the thread moved on" });
			}
		},
		pendingCount: () => Object.values(rc.st.threads).filter((r) => r.pending).length,
		tripped: () => tripped(rc),
		/** Stops the timers. The persisted state is kept, so the next process re-arms what was pending. */
		stop() {
			for (const c of rc.timers.values()) c();
			rc.timers.clear();
		},
	};
}
export type Recovery = ReturnType<typeof createRecovery>;

export type Where = { thread: string; server: string; threadId: string };
/** What the engine does with a `Handling`: stop (no wake), or the words the ordinary failed wake should carry; `ask` is a decision-queue item to raise. */
export type Outcome = {
	stop?: true;
	note?: string;
	what?: string;
	ask?: { why: "breaker" | "verdict"; kind: FailureKind; count: number; item: object };
};

/** Pure: the engine's reading of a `Handling`. The one place that words a verdict or an outage for the Steward and the queue. */
export function outcomeOf(
	h: Handling,
	where: Where,
	timing: Pick<RecoverTiming, "breakerWindowMs"> = DEFAULT_RECOVER_TIMING,
): Outcome {
	switch (h.action) {
		case "duplicate":
		case "retry-scheduled":
			return { stop: true };
		case "wake":
			return { note: h.note };
		case "breaker":
			return {
				stop: true,
				...(h.alarm
					? {
							ask: {
								why: "breaker" as const,
								kind: h.kind,
								count: h.count,
								item: breakerItem(h.kind, h.count, timing.breakerWindowMs, where),
							},
						}
					: {}),
			};
		case "verdict": {
			const said =
				h.verdict === "unjudged"
					? `the judge could not answer (${h.reason})`
					: `${h.backend} judge: ${h.verdict.replaceAll("_", " ")} — ${h.reason}`;
			return {
				what: `run failed twice (${h.kind.replaceAll("_", " ")}) after an automatic retry`,
				note: `${said}. The daemon retries this thread no more until it finishes a turn.${h.ask ? " The principal has been asked on the decision queue." : ""}`,
				...(h.ask
					? {
							ask: {
								why: "verdict" as const,
								kind: h.kind,
								count: 2,
								item: verdictItem(h.kind, h.reason, h.backend, where),
							},
						}
					: {}),
			};
		}
	}
}

/** Pure: the decision-queue item for the one outage alarm. `thread` and `server` name where it was seen. */
export function breakerItem(
	kind: FailureKind,
	count: number,
	windowMs: number,
	where: { thread: string; server: string; threadId?: string },
): object {
	return {
		kind: "only-you",
		title: `Provider outage: ${count} "${kind}" failures in ${Math.round(windowMs / MIN)} minutes, automatic retries stopped`,
		context: [
			`- ${count} runs failed with ${kind.replaceAll("_", " ")} within ${Math.round(windowMs / MIN)} minutes, across threads.`,
			"- All automatic retries are stopped until ten quiet minutes pass.",
			"- The Steward is not woken for each failed thread while this holds; the daemon log lists them.",
		].join("\n"),
		options: [
			{ label: "Acknowledge", detail: "Nothing to do; retries resume after ten quiet minutes." },
			{ label: "Investigate now", detail: "Hand it to the Steward to find the cause." },
		],
		recommended: 0,
		thread: where.thread,
		server: where.server,
		...(where.threadId ? { threadId: where.threadId } : {}),
		tag: "Outage",
	};
}

/** Pure: the decision-queue item for a judge verdict that needs the principal. */
export function verdictItem(
	kind: FailureKind,
	reason: string,
	backend: string,
	where: { thread: string; server: string; threadId: string },
): object {
	return {
		kind: "only-you",
		title: `"${where.thread.slice(0, 60)}" failed twice (${kind.replaceAll("_", " ")}) and needs your call`,
		context: [
			`- The daemon retried once and the retry failed too.`,
			`- ${backend} judge: ${reason || "no reason given"}`,
			"- The daemon retries this thread no more until it finishes a turn.",
		].join("\n"),
		options: [
			{ label: "Leave it", detail: "Nothing more is sent to the thread." },
			{ label: "Have the Steward look", detail: "The Steward reads the thread and decides." },
		],
		recommended: 1,
		thread: where.thread,
		server: where.server,
		threadId: where.threadId,
		tag: "Failed twice",
	};
}

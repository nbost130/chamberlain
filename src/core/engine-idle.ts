/**
 * The idle-parents timer: on its own schedule (`sweep.idleParents.intervalMinutes`, default 15), not the routine sweep's, list the top-level
 * threads that finished and went quiet, and wake the Steward once with the ones not yet reported at their last message. The engine's
 * once-a-minute housekeeping calls `tick`; the check's own clock decides whether it is due, so the schedule is the check's and survives a
 * restart. No model call is made (src/core/idle-parents.ts). Split out of createEngine (src/core/engine.ts), like the sweep.
 */
import type { Outbox } from "./deliver.ts";
import { IDLE_PARENTS_SOURCE, idleParentsSource, selectIdleThreads, type IdleThreadSource } from "./idle-parents.ts";
import type { Log } from "./log.ts";
import { idleThreadsWake } from "./messages.ts";
import { evaluateSource, recordEvaluation } from "./source.ts";
import type { Store } from "./store.ts";
import { fenced, idleParentsConfig } from "./sweep.ts";

export const IDLE_CLOCK = "idle-parents-clock";
export type IdleClock = { lastAt: number };

export type IdleParentsDeps = {
	store: Store;
	log: Log;
	outbox: Outbox;
	/** The config directory: where `sweep.idleParents` is read from, on every tick, so an edit takes hold at once. */
	conf: string;
	/** The watchers, as sources of threads to select from. */
	sources: () => readonly IdleThreadSource[];
	/** The thread ids that are never idle parents: the Steward, the decisions thread, the Alert Desk, the exclude list. */
	skip: () => ReadonlySet<string>;
	now?: () => number;
};

export function createIdleParents({ store, log, outbox, conf, sources, skip, now = Date.now }: IdleParentsDeps) {
	let running = false;
	/** Runs the check when its own interval has passed since it last ran. Never throws into the caller's other checks. */
	async function tick(): Promise<void> {
		if (running) return;
		const cfg = idleParentsConfig(conf);
		if (!cfg.enabled) return;
		const at = now();
		const prior = store.state.get<Partial<IdleClock>>(IDLE_CLOCK);
		if (typeof prior?.lastAt === "number" && at - prior.lastAt < cfg.intervalMinutes * 60_000) return;
		running = true;
		try {
			const source = idleParentsSource({
				cfg,
				select: () => selectIdleThreads(sources(), at, { thresholdMinutes: cfg.thresholdMinutes, skip: skip() }),
				prior: () =>
					store.items
						.list({ source: IDLE_PARENTS_SOURCE, status: ["triggered", "acknowledged"] })
						.map((i) => ({ dedupKey: i.dedupKey, text: String(i.payload.text ?? i.dedupKey) })),
			});
			// Reading writes nothing. What was found, the clock and the wake are then one transaction, as in the sweep: a crash between
			// recording a thread as reported and queueing its wake would lose the report for good.
			const evaluation = await evaluateSource(source);
			outbox.commit(() => {
				const outcome = recordEvaluation(store, evaluation, { now: at });
				store.state.set(IDLE_CLOCK, { lastAt: at } satisfies IdleClock);
				log("idle-parents", {
					reported: outcome.notified.length,
					...(outcome.ok ? {} : { error: outcome.error }),
				});
				if (!outcome.notified.length) return undefined;
				const block = outcome.notified.map((i) => `- ${fenced(String(i.payload.text ?? i.dedupKey))}`).join("\n");
				return {
					message: idleThreadsWake(outcome.notified.length, block),
					deliveryId: `idle-parents:${at}`,
					meta: { kind: "sweep" },
				};
			});
		} finally {
			running = false;
		}
	}
	return { tick };
}

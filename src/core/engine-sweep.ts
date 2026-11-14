/**
 * The routine sweep: once a minute, away or not, run the configured checks when a sweep is due, and wake the Steward only for what they
 * find. The sweep is a timer that runs sources; the item system decides what notifies (src/core/source.ts). Split out of createEngine
 * (src/core/engine.ts), which passes it the few things it reads.
 */
import { readFileSync } from "node:fs";
import { readAfk } from "./afk.ts";
import { principal } from "./config.ts";
import type { Outbox } from "./deliver.ts";
import { IDLE_PARENTS_SOURCE, idleParentsSource, type IdleParentsRead } from "./idle-parents.ts";
import type { Log } from "./log.ts";
import { evaluateSource, recordEvaluation, type Evaluation } from "./source.ts";
import type { Store } from "./store.ts";
import {
	type BusyFact,
	configuredSources,
	idleParentsConfig,
	renderSweepPrompt,
	runawaySource,
	SWEEP_MS,
	sweepAction,
	sweepClock,
	sweepMessage,
	type SweepClock,
} from "./sweep.ts";

export type SweepDeps = {
	store: Store;
	log: Log;
	outbox: Outbox;
	/** The config directory: where the configured checks and an own sweep-prompt.md live. */
	conf: string;
	/** A private file in the config directory, or undefined. */
	privateFile: (name: string) => string | undefined;
	/** The bundled full-sweep prompt, used when there is no sweep-prompt.md. */
	sweepPromptFile?: string | undefined;
	/** The watchers, which say which threads keep starting turns. */
	watchers: readonly {
		runawayCandidates(now: number): Promise<BusyFact[]>;
		idleParents(now: number, thresholdMs: number, skip: ReadonlySet<string>): Promise<IdleParentsRead>;
	}[];
	/** The thread ids the idle-parents check never reports: the Steward, the decisions thread, the Alert Desk, the exclude list. */
	idleSkip: () => ReadonlySet<string>;
};

export function createSweep({ store, log, outbox, conf, privateFile, sweepPromptFile, watchers, idleSkip }: SweepDeps) {
	/** Once a minute, away or not: run the routine checks when a sweep is due, and wake the Steward only for what they find. */
	const SWEEP_CLOCK = "sweep-clock";
	/** The full-sweep prompt: sweep-prompt.md in the config directory if there is one, else the bundled template. */
	const sweepPrompt = () => {
		const own = privateFile("sweep-prompt.md");
		return renderSweepPrompt(own ?? (sweepPromptFile ? readFileSync(sweepPromptFile, "utf8") : ""), principal());
	};
	const readSweep = (): Partial<SweepClock> | undefined => store.state.get<Partial<SweepClock>>(SWEEP_CLOCK);
	let sweeping = false;
	async function sweepTick() {
		if (sweeping) return;
		const now = Date.now();
		const prior = readSweep();
		const s = sweepClock(prior, now);
		if (!prior) store.state.set(SWEEP_CLOCK, s);
		if (s.seeded && now - s.lastAt < SWEEP_MS) return;
		sweeping = true;
		try {
			// Read before anything is consumed, and a broken record counts as here, which grants nothing.
			let away = false;
			try {
				away = Boolean(readAfk(store));
			} catch (e) {
				log("sweep-afk-unreadable", { error: String(e).slice(0, 200) });
			}
			const busy = (await Promise.all(watchers.map((w) => w.runawayCandidates(now)))).flat();
			// The sweep is a timer that runs sources; the item system decides what notifies (src/core/source.ts). Running a source
			// writes nothing. What they found, what notified, the clock and the wake are then ONE transaction (`commit` in
			// deliver.ts): a crash between recording a finding as notified and queueing its wake would lose the alert for good.
			const evaluations: Evaluation[] = [];
			const idle = idleParentsConfig(conf);
			const idleSource = idle.enabled
				? idleParentsSource({
						cfg: idle,
						gather: async () => {
							const reads = await Promise.all(
								watchers.map((w) => w.idleParents(now, idle.thresholdMinutes * 60_000, idleSkip())),
							);
							return { facts: reads.flatMap((r) => r.facts), unreadable: reads.flatMap((r) => r.unreadable) };
						},
						prior: () =>
							store.items
								.list({ source: IDLE_PARENTS_SOURCE, status: ["triggered", "acknowledged"] })
								.map((i) => ({ dedupKey: i.dedupKey, text: String(i.payload.text ?? i.dedupKey) })),
						now: () => now,
					})
				: undefined;
			for (const src of [runawaySource(busy), ...(idleSource ? [idleSource] : []), ...configuredSources(conf)])
				evaluations.push(await evaluateSource(src));
			outbox.commit(() => {
				const outcomes = evaluations.map((e) => recordEvaluation(store, e, { now, firstRun: !s.seeded }));
				const action = sweepAction(outcomes, now - s.lastFullAt);
				store.state.set(SWEEP_CLOCK, {
					lastAt: now,
					lastFullAt: action.wake === "full" ? now : s.lastFullAt,
					seeded: true,
				} satisfies SweepClock);
				log("sweep", {
					wake: action.wake,
					findings: action.fresh.map((x) => x.item),
					errored: action.errored,
					...(action.shadow.length ? { shadow: action.shadow } : {}),
				});
				return action.wake === "none"
					? undefined
					: { message: sweepMessage(action, sweepPrompt(), away), deliveryId: `sweep:${now}`, meta: { kind: "sweep" } };
			});
		} finally {
			sweeping = false;
		}
	}

	return { tick: sweepTick };
}

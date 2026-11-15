/**
 * The idle-parents timer: on its own schedule (`sweep.idleParents.intervalMinutes`, default 15), list the top-level
 * threads that finished and went quiet, and wake the Steward once with the ones due (first report or a `repeatHours`
 * re-raise). When `threads.steward` changes, open idle findings are resolved and re-queued as one digest for the new Steward
 * (uncapped, including persisted findings for servers that cannot be reread), in the same outbox commit as the wake.
 */
import { heldOpen } from "./afk-held.ts";
import { type ClassifyDeps, classifyIdle } from "./classifier/classify.ts";
import type { Outbox } from "./deliver.ts";
import {
	DIGEST_PREFIX,
	idleParentsSource,
	idlePrior,
	openIdleParents,
	resolveOpenIdleParents,
} from "./idle-parents.ts";
import { type IdleThreadSource, selectIdleThreads } from "./idle-select.ts";
import { thread as stewardThread } from "./layout.ts";
import type { Log } from "./log.ts";
import { idleThreadsWake } from "./messages.ts";
import { evaluateSource, recordEvaluation } from "./source.ts";
import type { Store } from "./store.ts";
import { fenced, idleParentsConfig } from "./sweep.ts";

const IDLE_CLOCK = "idle-parents-clock";
const STEWARD_STATE = "idle-parents-steward";
export type IdleClock = { lastAt: number };
type StewardState = { threadId: string };

export type IdleParentsDeps = {
	store: Store;
	log: Log;
	outbox: Outbox;
	conf: string;
	sources: () => readonly IdleThreadSource[];
	skip: () => ReadonlySet<string>;
	now?: () => number;
	provider?: ClassifyDeps["provider"];
};

/** Thread ids the Steward has an open hold for: idle-parents stays quiet on those. */
function heldThreadIds(store: Store): Set<string> {
	const ids = new Set<string>();
	for (const h of heldOpen(store)) {
		const id = h.threadId ?? h.ref?.threadId;
		if (id) ids.add(id);
	}
	return ids;
}

export function createIdleParents({
	store,
	log,
	outbox,
	conf,
	sources,
	skip,
	now = Date.now,
	provider,
}: IdleParentsDeps) {
	let running = false;
	async function tick(): Promise<void> {
		if (running) return;
		const cfg = idleParentsConfig(conf);
		if (!cfg.enabled) return;
		const at = now();
		const priorClock = store.state.get<Partial<IdleClock>>(IDLE_CLOCK);
		if (typeof priorClock?.lastAt === "number" && at - priorClock.lastAt < cfg.intervalMinutes * 60_000) return;
		running = true;
		try {
			await runIdlePass({ store, log, outbox, conf, sources, skip, at, cfg, provider });
		} finally {
			running = false;
		}
	}
	return { tick };
}

type Pass = {
	store: Store;
	log: Log;
	outbox: Outbox;
	conf: string;
	sources: () => readonly IdleThreadSource[];
	skip: () => ReadonlySet<string>;
	at: number;
	cfg: ReturnType<typeof idleParentsConfig>;
	provider?: ClassifyDeps["provider"];
};

async function runIdlePass(p: Pass): Promise<void> {
	const { store, log, outbox, conf, sources, skip, at, cfg, provider } = p;
	const stewardId = stewardThread(conf, "steward") ?? "";
	const prev = store.state.get<Partial<StewardState>>(STEWARD_STATE);
	const stewardChanged = Boolean(stewardId && prev?.threadId && prev.threadId !== stewardId);
	// Snapshot open findings before the commit; resolve + wake share one outbox transaction.
	const handoff = stewardChanged ? openIdleParents(store) : [];
	const skipAll = new Set([...skip(), ...heldThreadIds(store)]);
	const source = idleParentsSource({
		cfg,
		select: () => selectIdleThreads(sources(), at, { thresholdMinutes: cfg.thresholdMinutes, skip: skipAll }),
		prior: () => idlePrior(store),
		handoff: () => handoff,
		...(cfg.classifier.provider === "none"
			? {}
			: {
					classify: async (threads) => ({
						mode: cfg.classifier.mode,
						day: new Date(at).toISOString().slice(0, 10),
						byKey: await classifyIdle(threads, cfg.classifier, {
							store,
							conf,
							log,
							now: at,
							...(provider ? { provider } : {}),
						}),
					}),
				}),
	});
	const evaluation = await evaluateSource(source);
	outbox.commit(() => {
		if (stewardChanged) resolveOpenIdleParents(store, at);
		const outcome = recordEvaluation(store, evaluation, { now: at });
		store.state.set(IDLE_CLOCK, { lastAt: at } satisfies IdleClock);
		if (stewardId) store.state.set(STEWARD_STATE, { threadId: stewardId } satisfies StewardState);
		log("idle-parents", {
			reported: outcome.notified.length,
			...(stewardChanged ? { stewardChanged: true } : {}),
			...(outcome.ok ? {} : { error: outcome.error }),
		});
		if (!outcome.notified.length) return undefined;
		const block = outcome.notified.map((i) => `- ${fenced(String(i.payload.text ?? i.dedupKey))}`).join("\n");
		return {
			message: idleThreadsWake(
				outcome.notified.filter((i) => !i.dedupKey.startsWith(DIGEST_PREFIX)).length,
				block,
				cfg.classifier.provider !== "none" && cfg.classifier.mode === "live",
			),
			deliveryId: `idle-parents:${at}`,
			meta: { kind: "sweep" },
		};
	});
}

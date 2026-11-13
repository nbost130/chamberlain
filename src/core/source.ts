/**
 * Item sources. A source is anything that can say, on demand, what currently needs attention: a routine check, the
 * runaway-thread counter, a future monitor of pull requests, runs or deploys. Running a source turns what it reports into
 * items (src/core/store.ts, the one item system), and that is the ONLY way a thing is tracked, de-duplicated and
 * re-notified: there is no "seen" list, no "sticky" flag and no per-source bookkeeping outside the items table.
 *
 * What a run does to the items of a source:
 *   - every finding is observed: created, refreshed, or reopened if it had resolved, and `decideNotification`
 *     (notification.ts) says whether it notifies now, from the finding's repeat policy (once by default, or again every
 *     `repeatIntervalMs`);
 *   - a finding the source no longer reports is resolved, so its return is a new occurrence that notifies again;
 *   - a source that could not run is in error, never clear (Grafana's Error state: the rule failed to evaluate): its findings
 *     keep their state (nothing is resolved on a guess) and one "evaluation_error" item notifies on every run until it runs
 *     again.
 *
 * The sweep (src/core/sweep.ts) is a timer that runs the sources; nothing else in the core needs to know what a source is.
 */
import { NOTIFY_ONCE, repeatEvery } from "./notification.ts";
import type { Item, ItemMode, RepeatPolicy, Store, Subject } from "./store.ts";

/** One thing a source says needs attention. Its `dedupKey` is stable and unique within the source. */
export type Finding = {
	dedupKey: string;
	text: string;
	/** Notify again this many ms after each notification while it persists (0: on every run). Default: notify once. */
	repeatIntervalMs?: number;
	/** At most this many notifications. Needs `repeatIntervalMs`. Default: without end. */
	maxNotifications?: number;
	/** Learn it silently when the source runs for the very first time (a standing condition that is not news). */
	baseline?: boolean;
	subject?: Subject;
};

export interface ItemSource {
	/** The item `source`: unique, such as "check:disk" or "runaway". */
	readonly name: string;
	/** silenced: track only. shadow: record what would be sent and notify nobody. live (default): notify. */
	readonly mode?: ItemMode;
	/** What needs attention now. Throwing means the source could not be evaluated. */
	run(): Promise<readonly Finding[]>;
}

export const FINDING = "finding";
/** The item kind (and dedup key) of a source that could not be evaluated: one per source. */
export const EVALUATION_ERROR = "evaluation_error";

/** The repeat policy a finding asks for. */
export const repeatPolicyOf = (f: Pick<Finding, "repeatIntervalMs" | "maxNotifications">): RepeatPolicy => (f.repeatIntervalMs === undefined ? NOTIFY_ONCE : repeatEvery(f.repeatIntervalMs, f.maxNotifications));

export type SourceOutcome = {
	source: string;
	ok: boolean;
	error?: string;
	/** Items that notified on this run: what the wake is built from. */
	notified: Item[];
	/** Shadow mode: items that would have notified. */
	wouldNotify: Item[];
};

/** What a source in error says, for the wake. */
export const evaluationErrorText = (source: string, error: string) => `A routine check could not run: ${source}: ${error.replace(/\s+/g, " ").slice(0, 120)}.`;

/** What running a source found, not yet recorded: its findings, or the error that kept it from running. Nothing is written to run one. */
export type Evaluation = { src: ItemSource; findings?: readonly Finding[]; error?: string };

/** Runs a source's own code. It never throws and writes nothing: a source that throws is in error. */
export async function evaluateSource(src: ItemSource): Promise<Evaluation> {
	try { return { src, findings: await src.run() }; } catch (e) { return { src, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Records one evaluation in the item system and says what notified. Synchronous, and a transaction of its own that nests: a
 * caller that also writes the wake (the engine's sweep) calls this inside the transaction that writes it, so the notification
 * decisions and the wake commit together or not at all. `firstRun` is true only for the first run there has ever been, the
 * snapshot taken when watching starts, when findings marked `baseline` are learned silently.
 */
export function recordEvaluation(store: Store, e: Evaluation, o: { now?: number; firstRun?: boolean } = {}): SourceOutcome {
	const now = o.now ?? Date.now();
	const { src, findings, error } = e;
	const mode = src.mode ?? "live";
	return store.tx(() => {
		const notified: Item[] = [], wouldNotify: Item[] = [];
		const take = (r: ReturnType<Store["items"]["observe"]>) => { if (r.notify) notified.push(r.item); else if (r.wouldNotify) wouldNotify.push(r.item); };
		if (findings === undefined) {
			// In error: the findings it had keep their state, and one item notifies on every run until it can run again.
			take(store.items.observe({ source: src.name, kind: EVALUATION_ERROR, dedupKey: EVALUATION_ERROR, mode, repeat: repeatEvery(0), payload: { text: evaluationErrorText(src.name, error ?? "failed") }, now }));
			return { source: src.name, ok: false, error: error ?? "failed", notified, wouldNotify };
		}
		store.items.resolve(src.name, EVALUATION_ERROR, now);
		for (const f of findings) {
			take(store.items.observe({
				source: src.name, kind: FINDING, dedupKey: f.dedupKey, mode, repeat: repeatPolicyOf(f), baseline: f.baseline === true && o.firstRun === true,
				...(f.subject ? { subject: f.subject } : {}), payload: { text: f.text }, now,
			}));
		}
		store.items.resolveAbsent(src.name, FINDING, findings.map((f) => f.dedupKey), now);
		return { source: src.name, ok: true, notified, wouldNotify };
	});
}

/** Runs one source and records what it found, in that order: the run first (it may take a while and writes nothing), then one transaction. */
export async function runSource(store: Store, src: ItemSource, o: { now?: number; firstRun?: boolean } = {}): Promise<SourceOutcome> {
	return recordEvaluation(store, await evaluateSource(src), o);
}

/** Runs every source, one after another, and reports each outcome. A source that throws is in error and never stops the rest. */
export async function runSources(store: Store, sources: readonly ItemSource[], o: { now?: number; firstRun?: boolean } = {}): Promise<SourceOutcome[]> {
	const out: SourceOutcome[] = [];
	for (const s of sources) out.push(await runSource(store, s, o));
	return out;
}

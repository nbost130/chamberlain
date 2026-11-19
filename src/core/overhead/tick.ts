/**
 * The overhead tick. Each call first RECONCILES the reservations (see below), then, once per `checkEveryHours`, measures, keeps the numbers for
 * the Decisions view and, when a limit is crossed and the guards in trigger.ts allow it, opens an investigator thread through `investigator`,
 * which the daemon gives it (the T3 adapter); this module never talks to T3 itself.
 *
 * The launch is made so that its outcome can be lost without launching twice:
 * 1. the reservation is recorded as `pending`, with its title and brief, BEFORE any command goes out, and its id is the seed of every id the
 *    launch sends, so a repeat is the same commands;
 * 2. a reservation leaves `pending` ONLY by reconciliation that positively shows no thread exists for its seed (T3 answers, and has none), or
 *    by T3 showing the thread with its brief. A refused launch (LaunchRefused), an error, a lost response, a failed inspection: none of these
 *    releases it. A refusal on a retry whose thread T3 already created would otherwise free the slot for a second live investigator;
 * 3. reconciliation, now and after a restart, asks T3 what the seed became. A thread with its brief makes the reservation `open`; otherwise the
 *    same launch is repeated (idempotent by seed), unless the investigator is disabled: then reconciliation only observes and closes, and never
 *    sends a brief or makes a thread.
 * A reservation past `ttlHours` is stale: it stays held until T3 shows its thread settled, idle, archived or gone, and only then is it closed.
 * Nothing here restarts, deploys or edits anything: it measures, records and asks for a thread.
 */
import { randomBytes } from "node:crypto";
import type { GhRead } from "../decide/hold-lookup.ts";
import type { Store } from "../store/store.ts";
import { type BriefCommands, investigatorBrief } from "./brief.ts";
import { advanceClock } from "./clock.ts";
import { collect } from "./collect.ts";
import { HOUR_MS, type OverheadConfig } from "./config.ts";
import type { RunQuery } from "./fleet-spend.ts";
import { summarize } from "./format.ts";
import { type Investigator, LaunchRefused } from "./investigator.ts";
import type { OwnThreads } from "./managed.ts";
import { priceOf } from "./prices.ts";
import {
	type Clock,
	clockElapsed,
	decide,
	type Elapsed,
	heldNotes,
	type Investigation,
	markChecked,
	readOverheadState,
	recordOpened,
	staleOf,
	updateInvestigation,
} from "./trigger.ts";

/** Reservations are reconciled at most this often, however often the tick is called. */
const RECONCILE_MS = 5 * 60_000;

type Event = "overhead-checked" | "overhead-investigation" | "overhead-error";

export type OverheadTickDeps = {
	store: Store;
	cfg: OverheadConfig;
	/** The Steward's model from `models.steward`; undefined when none is configured. */
	model?: string;
	gh: GhRead;
	query?: RunQuery;
	/** The threads Chamberlain runs itself, read at each measurement: never counted as managed (settings.ts `ownThreads`). */
	own?: () => OwnThreads;
	/** Absent: no investigator can be launched (not configured), and a crossing is only recorded. */
	investigator?: Investigator;
	commands: BriefCommands;
	now?: () => number;
	/** A monotonic clock in ms (default `performance.now`): feeds the persisted cooldown clock (clock.ts), so a cooldown is never shorter than it says. */
	mono?: () => number;
	log: (event: Event, fields: Record<string, unknown>) => void;
};

/** What one attempt to send a launch came to. */
type Sent = "opened" | "refused" | "unknown";

const markOpen = (d: OverheadTickDeps, i: Investigation, threadId: string) => {
	updateInvestigation(d.store, i.id, { status: "open", threadId, brief: undefined, title: undefined });
	d.log("overhead-investigation", { id: i.id, thread: threadId, crossings: i.crossings.length });
};

/** A reservation whose thread T3 has positively shown not to exist is closed: nothing was launched, so it holds neither the slot nor the cooldown. */
const release = (d: OverheadTickDeps, i: Investigation, now: number, note: string) =>
	updateInvestigation(d.store, i.id, {
		status: "closed",
		closedAt: now,
		closedBy: "launch-failed",
		note,
		brief: undefined,
		title: undefined,
	});

/** Sends (or repeats) the launch of a reservation. It records only a launch that completed; what the outcome means for the reservation is the caller's. */
async function send(d: OverheadTickDeps, inv: Investigator, i: Investigation): Promise<Sent> {
	if (!i.title || !i.brief) {
		d.log("overhead-error", { stage: "launch", id: i.id, error: new LaunchRefused("the reservation has no brief") });
		return "refused";
	}
	try {
		const { threadId } = await inv.launch({ seed: i.id, title: i.title, brief: i.brief });
		markOpen(d, i, threadId);
		return "opened";
	} catch (e) {
		if (e instanceof LaunchRefused) {
			d.log("overhead-error", { stage: "launch", id: i.id, error: e });
			return "refused";
		}
		d.log("overhead-error", { stage: "launch-unconfirmed", id: i.id, error: e });
		return "unknown";
	}
}

/** What T3 holds for a seed, or undefined when it cannot say (logged): an answer that cannot be had is never read as "no thread". */
async function inspect(d: OverheadTickDeps, inv: Investigator, i: Investigation) {
	try {
		return await inv.inspect(i.id);
	} catch (e) {
		d.log("overhead-error", { stage: "reconcile", id: i.id, error: e });
		return undefined;
	}
}

/**
 * One pending reservation: ask T3 what its seed became. A thread with its brief is open. Otherwise, with the investigator enabled, the launch is
 * repeated; if that is refused the reservation is released only when T3 showed no thread. With it disabled, a missing thread releases it and
 * nothing is ever sent.
 */
async function settlePending(d: OverheadTickDeps, inv: Investigator, i: Investigation, now: number): Promise<void> {
	const t = await inspect(d, inv, i);
	if (!t) return;
	if (t.exists && t.briefSent) return markOpen(d, i, t.threadId);
	if (!d.cfg.investigator.enabled) {
		if (!t.exists) release(d, i, now, "investigator disabled; T3 shows no thread");
		return;
	}
	if ((await send(d, inv, i)) === "refused" && !t.exists) release(d, i, now, "launch refused; T3 shows no thread");
}

/** One stale reservation: closed only if T3 shows its thread gone, archived or idle; any other answer, or none, keeps it held. */
async function settleStale(d: OverheadTickDeps, inv: Investigator, i: Investigation, now: number): Promise<void> {
	const t = await inspect(d, inv, i);
	if (t && (!t.exists || t.archived || !t.active))
		updateInvestigation(d.store, i.id, { status: "closed", closedAt: now, closedBy: "expired" });
}

/** Reconciles every pending reservation, then every stale open one. Without an investigator nothing can be asked, so every reservation stays held. */
async function reconcile(d: OverheadTickDeps, now: number, elapsed: Elapsed): Promise<void> {
	const inv = d.investigator;
	if (!inv) return;
	for (const i of readOverheadState(d.store).investigations.filter((x) => x.status === "pending"))
		await settlePending(d, inv, i, now);
	const stale = new Set(staleOf(readOverheadState(d.store), elapsed, d.cfg).map((x) => x.id));
	for (const i of readOverheadState(d.store).investigations.filter((x) => x.status === "open" && stale.has(x.id)))
		await settleStale(d, inv, i, now);
}

/** Reserves, then launches. The brief is built first: a failure to build it reserves nothing. */
async function open(
	d: OverheadTickDeps,
	inv: Investigator,
	report: Awaited<ReturnType<typeof collect>>,
	at: { now: number; clock: Clock },
): Promise<void> {
	const id = `OV-${randomBytes(3).toString("hex")}`;
	const price = d.model ? priceOf(d.cfg.prices, d.model) : undefined;
	const rows = d.store.usage.list({ since: at.now - report.windowMs }).filter((r) => r.startedAt < at.now);
	const brief = investigatorBrief({
		id,
		report,
		rows,
		...(price ? { price } : {}),
		cacheWrite: d.cfg.cacheWrite,
		commands: d.commands,
		...(d.cfg.investigator.instructions ? { extra: d.cfg.investigator.instructions } : {}),
	});
	const title = `${d.cfg.investigator.title} ${new Date(at.now).toISOString().slice(0, 10)} ${id}`;
	const rec: Investigation = {
		id,
		openedAt: at.now,
		openedClock: at.clock.ms,
		status: "pending",
		title,
		brief,
		crossings: report.crossings.map((c) => c.detail),
	};
	recordOpened(d.store, rec);
	if ((await send(d, inv, rec)) !== "refused") return;
	// Refused before anything went out: still released only on T3's own word that no thread exists.
	const t = await inspect(d, inv, rec);
	if (t && !t.exists) release(d, rec, at.now, "launch refused; T3 shows no thread");
}

/** Whether the interval since the last measurement has passed. A clock that went backwards is treated as passed, so it cannot stall the monitor. */
const checkDue = (d: OverheadTickDeps, last: number | undefined, now: number): boolean =>
	last === undefined || now < last || now - last >= d.cfg.checkEveryHours * HOUR_MS;

/** One measurement: the report, its numbers kept, and the decision whether to open an investigation. */
async function measure(d: OverheadTickDeps, at: { now: number; clock: Clock }, elapsed: Elapsed): Promise<void> {
	const report = await collect({
		store: d.store,
		cfg: d.cfg,
		...(d.model ? { model: d.model } : {}),
		gh: d.gh,
		...(d.query ? { query: d.query } : {}),
		...(d.own ? { own: d.own() } : {}),
		now: at.now,
	});
	const state = readOverheadState(d.store);
	const summary = summarize(report);
	summary.unavailable = [...summary.unavailable, ...heldNotes(state, elapsed, d.cfg)];
	markChecked(d.store, at.now, summary);
	const decision = decide({ crossings: report.crossings, state, elapsed, cfg: d.cfg });
	// With no investigator a crossing is recorded in the numbers and nothing is reserved: there is no thread to reconcile it against.
	const go = decision.open && d.investigator !== undefined;
	d.log("overhead-checked", {
		crossings: report.crossings.length,
		opened: go,
		...(go || (!decision.open && decision.reason === "no-crossing")
			? {}
			: { skipped: decision.open ? "no-investigator" : decision.reason }),
	});
	if (go && d.investigator) await open(d, d.investigator, report, at);
}

/** One daemon owns this tick. It measures at most once per `checkEveryHours`; a restart does not measure again early. */
export function overheadTicker(d: OverheadTickDeps) {
	let busy = false;
	let reconciledAt: number | undefined;
	let lastMono: number | undefined;
	return async () => {
		if (busy) return;
		busy = true;
		try {
			const now = (d.now ?? Date.now)();
			const mono = (d.mono ?? (() => performance.now()))();
			const clock = advanceClock(d.store, now, lastMono === undefined ? undefined : mono - lastMono);
			lastMono = mono;
			const elapsed = clockElapsed(now, clock);
			if (reconciledAt === undefined || now < reconciledAt || now - reconciledAt >= RECONCILE_MS) {
				reconciledAt = now;
				await reconcile(d, now, elapsed);
			}
			if (checkDue(d, readOverheadState(d.store).lastCheckAt, now)) await measure(d, { now, clock }, elapsed);
		} finally {
			busy = false;
		}
	};
}

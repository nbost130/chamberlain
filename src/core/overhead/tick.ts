/**
 * The overhead tick. Each call first RECONCILES the reservations (see below), then, once per `checkEveryHours`, measures, keeps the numbers for
 * the Decisions view and, when a limit is crossed and the guards in trigger.ts allow it, opens an investigator thread through `investigator`,
 * which the daemon gives it (the T3 adapter); this module never talks to T3 itself.
 *
 * The launch is made so that its outcome can be lost without launching twice:
 * 1. the reservation is recorded as `pending`, with its title and brief, BEFORE any command goes out, and its id is the seed of every id the
 *    launch sends, so a repeat is the same commands;
 * 2. only a launch that sent nothing (LaunchRefused) releases it. Any other failure, a response lost after T3 accepted the thread included, leaves
 *    it pending: an unknown outcome counts as launched;
 * 3. reconciliation, now and after a restart, asks T3 what the seed became. A thread with its brief makes the reservation `open`; otherwise the
 *    same launch is repeated (idempotent by seed). An answer that cannot be had leaves it pending.
 * A reservation past `ttlHours` is stale: it stays held until T3 shows its thread settled, idle, archived or gone, and only then is it closed.
 * Nothing here restarts, deploys or edits anything: it measures, records and asks for a thread.
 */
import { randomBytes } from "node:crypto";
import type { GhRead } from "../decide/hold-lookup.ts";
import { errClass } from "../obs/fields.ts";
import type { Store } from "../store/store.ts";
import { type BriefCommands, investigatorBrief } from "./brief.ts";
import { collect } from "./collect.ts";
import { HOUR_MS, type OverheadConfig } from "./config.ts";
import type { RunQuery } from "./fleet-spend.ts";
import { summarize } from "./format.ts";
import { type Investigator, LaunchRefused } from "./investigator.ts";
import type { OwnThreads } from "./managed.ts";
import { priceOf } from "./prices.ts";
import {
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
	/** A monotonic clock in ms (default `performance.now`): a cooldown is never shorter than it says, whatever the wall clock does. */
	mono?: () => number;
	log: (event: Event, fields: Record<string, unknown>) => void;
};

/** Reservations the monotonic clock has seen in this process, by the reading when each was made. */
type Seen = Map<string, number>;

const elapsedOf =
	(d: OverheadTickDeps, now: number, seen: Seen): Elapsed =>
	(i) => {
		const wall = Math.max(0, now - i.openedAt);
		const at = seen.get(i.id);
		return at === undefined ? wall : Math.min(wall, Math.max(0, (d.mono ?? (() => performance.now()))() - at));
	};

/** A reservation whose launch sent nothing is closed; any other state of it is left alone. */
const refused = (d: OverheadTickDeps, id: string, now: number, e: unknown) => {
	updateInvestigation(d.store, id, {
		status: "closed",
		closedAt: now,
		closedBy: "launch-failed",
		note: errClass(e),
		brief: undefined,
		title: undefined,
	});
	d.log("overhead-error", { stage: "launch", id, error: e });
};

/** Sends (or repeats) the launch of a reservation and records the outcome: open, closed (nothing sent), or still pending (unknown). */
async function launch(d: OverheadTickDeps, i: Investigation, now: number): Promise<void> {
	if (!d.investigator) return refused(d, i.id, now, new LaunchRefused("no investigator is configured"));
	if (!i.title || !i.brief) return refused(d, i.id, now, new LaunchRefused("the reservation has no brief"));
	try {
		const { threadId } = await d.investigator.launch({ seed: i.id, title: i.title, brief: i.brief });
		updateInvestigation(d.store, i.id, { status: "open", threadId, brief: undefined, title: undefined });
		d.log("overhead-investigation", { id: i.id, thread: threadId, crossings: i.crossings.length });
	} catch (e) {
		if (e instanceof LaunchRefused) return refused(d, i.id, now, e);
		d.log("overhead-error", { stage: "launch-unconfirmed", id: i.id, error: e });
	}
}

/** One pending reservation: ask T3 what its seed became. A thread with its brief is open; otherwise the launch is repeated. */
async function settlePending(d: OverheadTickDeps, i: Investigation, now: number): Promise<void> {
	if (!d.investigator) return;
	try {
		const t = await d.investigator.inspect(i.id);
		if (t.exists && t.briefSent) {
			updateInvestigation(d.store, i.id, { status: "open", threadId: t.threadId, brief: undefined, title: undefined });
			d.log("overhead-investigation", { id: i.id, thread: t.threadId, crossings: i.crossings.length });
			return;
		}
	} catch (e) {
		d.log("overhead-error", { stage: "reconcile", id: i.id, error: e });
		return;
	}
	await launch(d, i, now);
}

/** One stale reservation: closed only if T3 shows its thread gone, archived or idle; any other answer, or none, keeps it held. */
async function settleStale(d: OverheadTickDeps, i: Investigation, now: number): Promise<void> {
	if (!d.investigator) return;
	try {
		const t = await d.investigator.inspect(i.id);
		const done = !t.exists || t.archived || !t.active;
		if (done) updateInvestigation(d.store, i.id, { status: "closed", closedAt: now, closedBy: "expired" });
	} catch (e) {
		d.log("overhead-error", { stage: "reconcile", id: i.id, error: e });
	}
}

/** Reconciles every pending reservation, then every stale open one. */
async function reconcile(d: OverheadTickDeps, now: number, elapsed: Elapsed): Promise<void> {
	const state = readOverheadState(d.store);
	for (const i of state.investigations.filter((x) => x.status === "pending")) await settlePending(d, i, now);
	const stale = new Set(staleOf(readOverheadState(d.store), elapsed, d.cfg).map((x) => x.id));
	for (const i of readOverheadState(d.store).investigations.filter((x) => x.status === "open" && stale.has(x.id)))
		await settleStale(d, i, now);
}

/** Reserves, then launches. The brief is built first: a failure to build it reserves nothing. */
async function open(
	d: OverheadTickDeps,
	report: Awaited<ReturnType<typeof collect>>,
	now: number,
	seen: Seen,
): Promise<void> {
	const id = `OV-${randomBytes(3).toString("hex")}`;
	const price = d.model ? priceOf(d.cfg.prices, d.model) : undefined;
	const rows = d.store.usage.list({ since: now - report.windowMs }).filter((r) => r.startedAt < now);
	const brief = investigatorBrief({
		id,
		report,
		rows,
		...(price ? { price } : {}),
		cacheWrite: d.cfg.cacheWrite,
		commands: d.commands,
		...(d.cfg.investigator.instructions ? { extra: d.cfg.investigator.instructions } : {}),
	});
	const title = `${d.cfg.investigator.title} ${new Date(now).toISOString().slice(0, 10)} ${id}`;
	const inv: Investigation = {
		id,
		openedAt: now,
		status: "pending",
		title,
		brief,
		crossings: report.crossings.map((c) => c.detail),
	};
	recordOpened(d.store, inv);
	seen.set(id, (d.mono ?? (() => performance.now()))());
	await launch(d, inv, now);
}

/** Whether the interval since the last measurement has passed. A clock that went backwards is treated as passed, so it cannot stall the monitor. */
const checkDue = (d: OverheadTickDeps, last: number | undefined, now: number): boolean =>
	last === undefined || now < last || now - last >= d.cfg.checkEveryHours * HOUR_MS;

/** One measurement: the report, its numbers kept, and the decision whether to open an investigation. */
async function measure(d: OverheadTickDeps, now: number, elapsed: Elapsed, seen: Seen): Promise<void> {
	const report = await collect({
		store: d.store,
		cfg: d.cfg,
		...(d.model ? { model: d.model } : {}),
		gh: d.gh,
		...(d.query ? { query: d.query } : {}),
		...(d.own ? { own: d.own() } : {}),
		now,
	});
	const state = readOverheadState(d.store);
	const summary = summarize(report);
	summary.unavailable = [...summary.unavailable, ...heldNotes(state, elapsed, d.cfg)];
	markChecked(d.store, now, summary);
	const decision = decide({ crossings: report.crossings, state, elapsed, cfg: d.cfg });
	d.log("overhead-checked", {
		crossings: report.crossings.length,
		opened: decision.open,
		...(decision.open || decision.reason === "no-crossing" ? {} : { skipped: decision.reason }),
	});
	if (decision.open) await open(d, report, now, seen);
}

/** One daemon owns this tick. It measures at most once per `checkEveryHours`; a restart does not measure again early. */
export function overheadTicker(d: OverheadTickDeps) {
	let busy = false;
	let reconciledAt: number | undefined;
	const seen: Seen = new Map();
	return async () => {
		if (busy) return;
		busy = true;
		try {
			const now = (d.now ?? Date.now)();
			const elapsed = elapsedOf(d, now, seen);
			if (reconciledAt === undefined || now < reconciledAt || now - reconciledAt >= RECONCILE_MS) {
				reconciledAt = now;
				await reconcile(d, now, elapsed);
			}
			if (checkDue(d, readOverheadState(d.store).lastCheckAt, now)) await measure(d, now, elapsed, seen);
		} finally {
			busy = false;
		}
	};
}

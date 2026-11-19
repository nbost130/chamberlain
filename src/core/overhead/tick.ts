/**
 * The overhead tick. Each call first RECONCILES the reservations (reconcile.ts), then, once per `checkEveryHours`, measures, keeps the numbers for
 * the Decisions view and, when a limit is crossed and the guards in trigger.ts allow it, opens an investigator thread through `investigator`,
 * which the daemon gives it (the T3 adapter); this module never talks to T3 itself.
 *
 * The launch is made so that its outcome can be lost without launching twice:
 * 1. the reservation is recorded as `pending`, with its title and brief, BEFORE any command goes out, and its id is the seed of every id the
 *    launch sends, so a repeat is the same commands under the same key, never a new reservation;
 * 2. a reservation leaves `pending` ONLY by reconciliation that positively shows no thread exists for its seed (T3 answers, and has none), or
 *    by T3 showing the thread with its brief. A refused launch (LaunchRefused), an error, a lost response, a failed inspection: none of these
 *    releases it. A refusal on a retry whose thread T3 already created would otherwise free the slot for a second live investigator;
 * 3. reconciliation, now and after a restart, asks T3 what the seed became. A thread with its brief makes the reservation `open`; otherwise the
 *    same launch is repeated (idempotent by seed), unless the investigator is disabled: then reconciliation only observes and closes, and never
 *    sends a brief or makes a thread;
 * 4. at most ONE launch call is made per tick, a retry and a new reservation together (reconcile.ts `send` spends the budget), and a pending
 *    reservation blocks any new one (trigger.ts `decide`), which also counts its cooldown from the later of its creation and its last launch call.
 * A reservation past `ttlHours` is stale: it stays held until T3 shows its thread settled, idle, archived or gone, and only then is it closed.
 * Nothing here restarts, deploys or edits anything: it measures, records and asks for a thread.
 */
import { randomBytes } from "node:crypto";
import { investigatorBrief } from "./brief.ts";
import { collect } from "./collect.ts";
import { HOUR_MS } from "./config.ts";
import { summarize } from "./format.ts";
import type { Investigator } from "./investigator.ts";
import { priceOf } from "./prices.ts";
import { type At, elapsedOf, inspect, newBudget, reconcile, release, send } from "./reconcile.ts";
import type { OverheadTickDeps } from "./tick-deps.ts";
import {
	decide,
	type Elapsed,
	heldNotes,
	type Investigation,
	markChecked,
	readOverheadState,
	recordOpened,
} from "./trigger.ts";

/** Reservations are reconciled at most this often, however often the tick is called. */
const RECONCILE_MS = 5 * 60_000;

/** Reserves, then launches. The brief is built first: a failure to build it reserves nothing. */
async function open(
	d: OverheadTickDeps,
	inv: Investigator,
	report: Awaited<ReturnType<typeof collect>>,
	at: At,
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
		status: "pending",
		title,
		brief,
		crossings: report.crossings.map((c) => c.detail),
	};
	recordOpened(d.store, rec);
	at.since.created.set(id, at.mono);
	if ((await send(d, inv, rec, at)) !== "refused") return;
	// Refused before anything went out: still released only on T3's own word that no thread exists.
	const t = await inspect(d, inv, rec);
	if (t && !t.exists) release(d, rec, at.now, "launch refused; T3 shows no thread");
}

/** Whether the interval since the last measurement has passed. A clock that went backwards is treated as passed, so it cannot stall the monitor. */
const checkDue = (d: OverheadTickDeps, last: number | undefined, now: number): boolean =>
	last === undefined || now < last || now - last >= d.cfg.checkEveryHours * HOUR_MS;

/** Why a measurement that crossed something did not open an investigation, or undefined when it did or nothing crossed. */
function skippedOf(decision: ReturnType<typeof decide>, d: OverheadTickDeps, at: At): string | undefined {
	if (!decision.open) return decision.reason === "no-crossing" ? undefined : decision.reason;
	if (!d.investigator) return "no-investigator"; // a crossing is recorded in the numbers; nothing is reserved without a thread to reconcile it against
	return at.budget.left < 1 ? "one-launch-per-tick" : undefined;
}

/** One measurement: the report, its numbers kept, and the decision whether to open an investigation. */
async function measure(d: OverheadTickDeps, at: At, elapsed: Elapsed): Promise<void> {
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
	const skipped = skippedOf(decision, d, at);
	const go = decision.open && skipped === undefined;
	d.log("overhead-checked", {
		crossings: report.crossings.length,
		opened: go,
		...(skipped !== undefined ? { skipped } : {}),
	});
	if (go && d.investigator) await open(d, d.investigator, report, at);
}

/** One daemon owns this tick. It measures at most once per `checkEveryHours`; a restart does not measure again early. */
export function overheadTicker(d: OverheadTickDeps) {
	let busy = false;
	let reconciledAt: number | undefined;
	const since = { created: new Map<string, number>(), launched: new Map<string, number>() };
	return async () => {
		if (busy) return;
		busy = true;
		try {
			const at: At = {
				now: (d.now ?? Date.now)(),
				mono: (d.mono ?? (() => performance.now()))(),
				since,
				budget: newBudget(),
			};
			const elapsed = elapsedOf(at);
			if (reconciledAt === undefined || at.now < reconciledAt || at.now - reconciledAt >= RECONCILE_MS) {
				reconciledAt = at.now;
				await reconcile(d, at, elapsed);
			}
			if (checkDue(d, readOverheadState(d.store).lastCheckAt, at.now)) await measure(d, at, elapsed);
		} finally {
			busy = false;
		}
	};
}

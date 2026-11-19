/**
 * The launch side of the overhead tick: sending a reservation's launch, and reconciling reservations against what T3 holds. Every launch call goes
 * through `send`, and `send` is the one place that spends the tick's launch budget, so the rule "at most ONE launch call per tick, total" cannot
 * be bypassed by a new code path. See tick.ts for the reservation contract.
 */
import { type Investigator, LaunchRefused } from "./investigator.ts";
import type { OverheadTickDeps } from "./tick-deps.ts";
import {
	type Elapsed,
	type Investigation,
	readOverheadState,
	staleOf,
	stampOf,
	updateInvestigation,
} from "./trigger.ts";

/** The most launch calls one tick makes, a retry of a pending reservation and a new reservation together. */
const LAUNCHES_PER_TICK = 1;

/** The monotonic readings this process took: when it made each reservation, and when it last sent each one's launch. A restart loses both. */
type Monos = { created: Map<string, number>; launched: Map<string, number> };

/** One tick's readings of the two clocks, the monotonic readings kept, and what is left of its launch budget. */
export type At = { now: number; mono: number; since: Monos; budget: { left: number } };

export const newBudget = () => ({ left: LAUNCHES_PER_TICK });

/**
 * How long a reservation has been held (since it was reserved), or with `"launch"` since the later of that and its last launch call. Across
 * restarts: the wall-clock time since the STORED time, with no credit for a restart. Inside the process that made it: the larger of that and the
 * monotonic time. Either one below zero (the clock reads earlier than the stored time) means the cooldown is not over, so 0. A real forward jump of
 * the wall clock cannot be told apart from time passing and ends the cooldown early: accepted.
 */
export const elapsedOf =
	(at: At): Elapsed =>
	(i, from) => {
		const wall = at.now - stampOf(i, from);
		const made =
			from === "launch" ? (at.since.launched.get(i.id) ?? at.since.created.get(i.id)) : at.since.created.get(i.id);
		const readings = made === undefined ? [wall] : [wall, at.mono - made];
		return readings.every(Number.isFinite) && readings.every((r) => r >= 0) ? Math.max(...readings) : 0;
	};

/** What one attempt to send a launch came to. `deferred`: the tick's launch budget was spent, nothing was sent. */
type Sent = "opened" | "refused" | "unknown" | "deferred";

const markOpen = (d: OverheadTickDeps, i: Investigation, threadId: string) => {
	updateInvestigation(d.store, i.id, { status: "open", threadId, brief: undefined, title: undefined });
	d.log("overhead-investigation", { id: i.id, thread: threadId, crossings: i.crossings.length });
};

/** A reservation whose thread T3 has positively shown not to exist is closed: nothing was launched, so it holds neither the slot nor the cooldown. */
export const release = (d: OverheadTickDeps, i: Investigation, now: number, note: string) =>
	updateInvestigation(d.store, i.id, {
		status: "closed",
		closedAt: now,
		closedBy: "launch-failed",
		note,
		brief: undefined,
		title: undefined,
	});

/**
 * Sends (or repeats) the launch of a reservation, under its own key, never a new one. The time of the call is stored BEFORE it goes out, so the
 * cooldown counts it even if the process dies mid-call. It records only a launch that completed; what the outcome means for the reservation is
 * the caller's.
 */
export async function send(d: OverheadTickDeps, inv: Investigator, i: Investigation, at: At): Promise<Sent> {
	if (!i.title || !i.brief) {
		d.log("overhead-error", { stage: "launch", id: i.id, error: new LaunchRefused("the reservation has no brief") });
		return "refused";
	}
	if (at.budget.left < 1) return "deferred";
	at.budget.left--;
	updateInvestigation(d.store, i.id, { launchedAt: at.now });
	at.since.launched.set(i.id, at.mono);
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
export async function inspect(d: OverheadTickDeps, inv: Investigator, i: Investigation) {
	try {
		return await inv.inspect(i.id);
	} catch (e) {
		d.log("overhead-error", { stage: "reconcile", id: i.id, error: e });
		return undefined;
	}
}

/**
 * One pending reservation: ask T3 what its seed became. A thread with its brief is open. Otherwise, with the investigator enabled, the launch is
 * repeated under the same key (if the tick's budget allows); if that is refused the reservation is released only when T3 showed no thread. With it
 * disabled, a missing thread releases it and nothing is ever sent.
 */
async function settlePending(d: OverheadTickDeps, inv: Investigator, i: Investigation, at: At): Promise<void> {
	const t = await inspect(d, inv, i);
	if (!t) return;
	if (t.exists && t.briefSent) return markOpen(d, i, t.threadId);
	if (!d.cfg.investigator.enabled) {
		if (!t.exists) release(d, i, at.now, "investigator disabled; T3 shows no thread");
		return;
	}
	if ((await send(d, inv, i, at)) === "refused" && !t.exists)
		release(d, i, at.now, "launch refused; T3 shows no thread");
}

/** One stale reservation: closed only if T3 shows its thread gone, archived or idle; any other answer, or none, keeps it held. */
async function settleStale(d: OverheadTickDeps, inv: Investigator, i: Investigation, now: number): Promise<void> {
	const t = await inspect(d, inv, i);
	if (t && (!t.exists || t.archived || !t.active))
		updateInvestigation(d.store, i.id, { status: "closed", closedAt: now, closedBy: "expired" });
}

/** Reconciles every pending reservation, then every stale open one. Without an investigator nothing can be asked, so every reservation stays held. */
export async function reconcile(d: OverheadTickDeps, at: At, elapsed: Elapsed): Promise<void> {
	const inv = d.investigator;
	if (!inv) return;
	for (const i of readOverheadState(d.store).investigations.filter((x) => x.status === "pending"))
		await settlePending(d, inv, i, at);
	const stale = new Set(staleOf(readOverheadState(d.store), elapsed, d.cfg).map((x) => x.id));
	for (const i of readOverheadState(d.store).investigations.filter((x) => x.status === "open" && stale.has(x.id)))
		await settleStale(d, inv, i, at.now);
}

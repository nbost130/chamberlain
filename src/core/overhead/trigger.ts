/**
 * When a crossing opens an investigation, and the record that keeps it from opening another. The record is Chamberlain's own state (key
 * `overhead`), so it survives a restart and `chamberlain overhead` shows the same thing the daemon acts on.
 *
 * A record is a RESERVATION with three states: `pending` (reserved before any command goes out; the launch outcome is not known yet),
 * `open` (T3 has the thread and its brief) and `closed`. The guards against a feedback loop, all decided in `decide`:
 * - at most one investigation per `investigator.cooldownHours`, counted from when the last one was RESERVED, pending ones included;
 * - no more than `investigator.maxOpen` held at once, held meaning pending or open;
 * - a reservation is released only on evidence, never by the clock: the launch was refused before anything was sent (`launch-failed`), T3 shows
 *   the thread settled, idle, archived or gone once `ttlHours` has passed (`expired`), or someone closes it (`chamberlain overhead close`). An
 *   outcome that is unknown counts as launched. Past `ttlHours` an investigation is STALE: it is reported, and still held;
 * - the record keeps every held reservation, and only the newest closed ones: history is capped, a live reservation never is.
 * Time here is only ever the clamp `elapsed` gives: never negative, and never longer than the monotonic clock saw in this process, so a clock
 * that jumps forward cannot shorten a cooldown. The investigator's own spend is its own line (fleet-spend.ts), outside the cost the trigger divides.
 */
import type { Store } from "../store/store.ts";
import type { Status } from "./collect.ts";
import { HOUR_MS, type OverheadConfig } from "./config.ts";
import type { Crossing } from "./metrics.ts";

export const OVERHEAD_KEY = "overhead";
/** How many CLOSED investigations are kept. Held ones are never counted against this. */
const KEEP_CLOSED = 20;

export type Investigation = {
	id: string;
	openedAt: number;
	/** `pending`: reserved, launch outcome unknown or not yet made. `open`: T3 has the thread and its brief. */
	status: "pending" | "open" | "closed";
	/** The T3 thread the investigator runs in; absent until the launch is confirmed. */
	threadId?: string;
	/** Kept while pending, so a retry sends byte-identical commands. Numbers and keys only (brief.ts). */
	title?: string;
	brief?: string;
	closedAt?: number;
	closedBy?: "investigator" | "operator" | "expired" | "launch-failed";
	/** What crossed, one line each, as the brief carried it. */
	crossings: string[];
	note?: string;
};

/** The numbers the Decisions view shows, kept from the last measurement so the page never has to call GitHub or the LifeOS database. */
export type OverheadSummary = {
	at: number;
	/** The configured window and trailing-baseline spans, as the labels the line shows ("24 h", "7 d"). */
	windowLabel: string;
	trailingLabel: string;
	prStatus: Status;
	fleetStatus: Status;
	costPerPrDay?: number;
	costPerPrTrailing?: number;
	prsDay?: number;
	stewardUsdDay?: number;
	noopRate?: number;
	spendShare?: number;
	crossings: string[];
	unavailable: string[];
};

export type OverheadState = {
	lastCheckAt?: number;
	last?: OverheadSummary;
	investigations: Investigation[];
};

export const readOverheadState = (store: Pick<Store, "state">): OverheadState =>
	store.state.get<OverheadState>(OVERHEAD_KEY) ?? { investigations: [] };

/** A reservation that still counts: pending or open. */
export const isHeld = (i: Investigation): boolean => i.status !== "closed";

/** How long a reservation has been held. Called with the monotonic-aware clamp in the daemon, the wall clock alone elsewhere; never negative. */
export type Elapsed = (i: Investigation) => number;

/** Pure: the wall-clock elapsed time, for a reader with no monotonic clock. A clock that went backwards is 0, not negative. */
export const wallElapsed =
	(now: number): Elapsed =>
	(i) =>
		Math.max(0, now - i.openedAt);

/** Pure: the held reservations older than the TTL. They are reported and stay held; only evidence from T3 releases them. */
export function staleOf(
	state: OverheadState,
	elapsed: Elapsed,
	cfg: Pick<OverheadConfig, "investigator">,
): Investigation[] {
	const ttlMs = cfg.investigator.ttlHours * HOUR_MS;
	return state.investigations.filter((i) => isHeld(i) && elapsed(i) >= ttlMs);
}

/** Pure: one line per held reservation that needs a look: a launch with no confirmed outcome, or one past its TTL. For the report and the view. */
export function heldNotes(state: OverheadState, elapsed: Elapsed, cfg: Pick<OverheadConfig, "investigator">): string[] {
	const stale = new Set(staleOf(state, elapsed, cfg).map((i) => i.id));
	const hours = (i: Investigation) => Math.round(elapsed(i) / HOUR_MS);
	return state.investigations.filter(isHeld).flatMap((i) => {
		const out: string[] = [];
		if (i.status === "pending")
			out.push(`investigation ${i.id}: launch outcome not confirmed (${hours(i)} h), held as launched until T3 says`);
		if (stale.has(i.id))
			out.push(
				`investigation ${i.id} is stale: held ${hours(i)} h, past ${cfg.investigator.ttlHours} h, until T3 shows its thread settled`,
			);
		return out;
	});
}

export type Decision =
	| { open: true }
	| { open: false; reason: "disabled" | "no-crossing" | "open-investigation" | "cooldown"; detail: string };

/** Pure: whether to open an investigation now. Pending, open and stale reservations all count; none is ever released by this function. */
export function decide(a: {
	crossings: readonly Crossing[];
	state: OverheadState;
	elapsed: Elapsed;
	cfg: OverheadConfig;
}): Decision {
	const inv = a.cfg.investigator;
	if (!a.cfg.enabled || !inv.enabled)
		return {
			open: false,
			reason: "disabled",
			detail: "overhead.enabled and overhead.investigator.enabled are both needed",
		};
	if (!a.crossings.length) return { open: false, reason: "no-crossing", detail: "no threshold crossed" };
	const held = a.state.investigations.filter(isHeld);
	if (held.length >= inv.maxOpen)
		return {
			open: false,
			reason: "open-investigation",
			detail: `${held.map((i) => `${i.id} (${i.status})`).join(", ")} held (at most ${inv.maxOpen})`,
		};
	const last = [...a.state.investigations].reverse().find((i) => i.closedBy !== "launch-failed");
	if (last && a.elapsed(last) < inv.cooldownHours * HOUR_MS)
		return {
			open: false,
			reason: "cooldown",
			detail: `${last.id} reserved ${Math.round(a.elapsed(last) / 60_000)} min ago; one investigation per ${inv.cooldownHours} h`,
		};
	return { open: true };
}

/** The list with the closed ones past the newest KEEP_CLOSED dropped, oldest first. A pending or open reservation is never dropped. */
function capClosed(list: Investigation[]): Investigation[] {
	const closed = list.filter((i) => !isHeld(i));
	const drop = new Set(closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED)));
	return list.filter((i) => !drop.has(i));
}

/** Reserves a new investigation, before any command goes out, so a launch whose outcome is lost is still on record. */
export function recordOpened(store: Pick<Store, "state">, inv: Investigation): void {
	store.state.update<OverheadState>(OVERHEAD_KEY, (prior) => {
		const s = prior ?? { investigations: [] };
		return { ...s, investigations: capClosed([...s.investigations, inv]) };
	});
}

/** Updates one investigation in place; an unknown id changes nothing. Returns the record as it now stands. */
export function updateInvestigation(
	store: Pick<Store, "state">,
	id: string,
	change: Partial<Investigation>,
): Investigation | undefined {
	let found: Investigation | undefined;
	store.state.update<OverheadState>(OVERHEAD_KEY, (prior) => {
		const s = prior ?? { investigations: [] };
		return {
			...s,
			investigations: capClosed(
				s.investigations.map((i) => {
					if (i.id !== id) return i;
					found = { ...i, ...change };
					return found;
				}),
			),
		};
	});
	return found;
}

/** Marks the check as done at `at`, so the daemon measures once per interval, and keeps its numbers for the Decisions view. */
export function markChecked(store: Pick<Store, "state">, at: number, last: OverheadSummary): void {
	store.state.update<OverheadState>(OVERHEAD_KEY, (prior) => ({
		...(prior ?? { investigations: [] }),
		lastCheckAt: at,
		last,
	}));
}

/** Closes an investigation by hand or by the investigator. An unknown id is an error; one already closed is left as it was. */
export function closeInvestigation(
	store: Pick<Store, "state">,
	id: string,
	o: { by: "investigator" | "operator"; now: number; note?: string },
): { investigation: Investigation; already: boolean } {
	const cur = readOverheadState(store).investigations.find((i) => i.id === id);
	if (!cur) throw Error(`overhead close: no investigation ${id}`);
	if (cur.status === "closed") return { investigation: cur, already: true };
	const investigation = updateInvestigation(store, id, {
		status: "closed",
		brief: undefined,
		title: undefined,
		closedAt: o.now,
		closedBy: o.by,
		...(o.note ? { note: o.note.slice(0, 500) } : {}),
	});
	return { investigation: investigation as Investigation, already: false };
}

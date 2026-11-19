/**
 * When a crossing opens an investigation, and the record that keeps it from opening another. The record is Chamberlain's own state (key
 * `overhead`), so it survives a restart and `chamberlain overhead` shows the same thing the daemon acts on.
 *
 * The guards against a feedback loop, all decided in `decide`:
 * - at most one investigation per `investigator.cooldownHours`, counted from when the last one was OPENED, so a quick one does not make the next sooner;
 * - no more than `investigator.maxOpen` open at once. One stays open until `chamberlain overhead close <id>` (the investigator runs it when it is
 *   done) or, so a lost thread cannot block the next forever, until `investigator.ttlHours` passes;
 * - a launch that failed never started anything, so it neither holds the cooldown nor stays open.
 * The investigator's own spend is reported as its own line (fleet-spend.ts) and is kept out of the cost the trigger divides.
 */
import type { Store } from "../store/store.ts";
import type { Status } from "./collect.ts";
import { HOUR_MS, type OverheadConfig } from "./config.ts";
import type { Crossing } from "./metrics.ts";

export const OVERHEAD_KEY = "overhead";
const KEEP = 20;

export type Investigation = {
	id: string;
	openedAt: number;
	/** The T3 thread the investigator runs in; absent until the launch returns. */
	threadId?: string;
	status: "open" | "closed";
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

/** Pure: the investigations as they stand at `now`: an open one older than the TTL is closed by the clock. */
export function settle(state: OverheadState, now: number, cfg: Pick<OverheadConfig, "investigator">): OverheadState {
	const ttlMs = cfg.investigator.ttlHours * HOUR_MS;
	return {
		...state,
		investigations: state.investigations.map((i) =>
			i.status === "open" && now - i.openedAt >= ttlMs
				? { ...i, status: "closed", closedAt: now, closedBy: "expired" }
				: i,
		),
	};
}

export type Decision =
	| { open: true }
	| { open: false; reason: "disabled" | "no-crossing" | "open-investigation" | "cooldown"; detail: string };

/** Pure: whether to open an investigation now. `state` is settled first, so an expired open one no longer blocks. */
export function decide(a: {
	crossings: readonly Crossing[];
	state: OverheadState;
	now: number;
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
	const state = settle(a.state, a.now, a.cfg);
	const open = state.investigations.filter((i) => i.status === "open");
	if (open.length >= inv.maxOpen)
		return {
			open: false,
			reason: "open-investigation",
			detail: `${open.map((i) => i.id).join(", ")} still open (at most ${inv.maxOpen})`,
		};
	const cooldownMs = inv.cooldownHours * HOUR_MS;
	const last = [...state.investigations].reverse().find((i) => i.closedBy !== "launch-failed");
	if (last && a.now - last.openedAt < cooldownMs)
		return {
			open: false,
			reason: "cooldown",
			detail: `${last.id} opened ${Math.round((a.now - last.openedAt) / 60_000)} min ago; one investigation per ${inv.cooldownHours} h`,
		};
	return { open: true };
}

/** Records a new open investigation, before the launch, so a crash between the launch and the record cannot launch twice. */
export function recordOpened(store: Pick<Store, "state">, inv: Investigation, now: number, cfg: OverheadConfig): void {
	store.state.update<OverheadState>(OVERHEAD_KEY, (prior) => {
		const s = settle(prior ?? { investigations: [] }, now, cfg);
		return { ...s, investigations: [...s.investigations, inv].slice(-KEEP) };
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
			investigations: s.investigations.map((i) => {
				if (i.id !== id) return i;
				found = { ...i, ...change };
				return found;
			}),
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
		closedAt: o.now,
		closedBy: o.by,
		...(o.note ? { note: o.note.slice(0, 500) } : {}),
	});
	return { investigation: investigation as Investigation, already: false };
}

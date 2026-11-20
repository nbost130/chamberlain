/** What the overhead tick is given (tick.ts), and what its launch side (reconcile.ts) reads from it. */
import type { GhRead } from "../decide/hold-lookup.ts";
import type { Store } from "../store/store.ts";
import type { BriefCommands } from "./brief.ts";
import type { OverheadConfig } from "./config.ts";
import type { RunQuery } from "./fleet-spend.ts";
import type { Investigator } from "./investigator.ts";
import type { OwnThreads } from "./managed.ts";

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
	/** A monotonic clock in ms (default `performance.now`), read inside one process for the reservations that process made; it dies with the process. */
	mono?: () => number;
	log: (event: Event, fields: Record<string, unknown>) => void;
};

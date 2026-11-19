/**
 * The managed overhead ratio's inputs: which threads Chamberlain supervised in the window (its own event log and outbox, managed.ts), what their
 * LifeOS sessions spent (managed-spend.ts), and the Chamberlain-caused spend to put over it. A read that fails is "unavailable", and the line that
 * says so carries a fixed error class, never the tool's text.
 */
import { errClass } from "../obs/fields.ts";
import type { Store } from "../store/store.ts";
import type { OverheadConfig } from "./config.ts";
import type { FleetSpend, RunQuery } from "./fleet-spend.ts";
import { joinManaged, type ManagedReport, managedFigures, managedThreads } from "./managed.ts";
import { managedSpend } from "./managed-spend.ts";
import { usable, type WindowMetrics } from "./metrics.ts";
import type { Status } from "./status.ts";

export type ManagedSection = {
	status: Status;
	report?: ManagedReport;
	/** Chamberlain-caused spend over the window: the numerator. Undefined when it is not known. */
	causedUsd?: number;
	/** causedUsd / the mapped threads' spend. PARTIAL whenever coverage is below 1. */
	ratio?: number;
	/** causedUsd / the managed thread count. */
	costPerThread?: number;
};

/** Chamberlain-caused spend: the Steward and its own calls, plus the threads it launches and the investigator (both read with the fleet). */
export const causedUsdOf = (day: WindowMetrics, fleet: FleetSpend | undefined): number | undefined =>
	fleet && usable(day.basisUsd) ? day.basisUsd + fleet.spawnedUsd + fleet.investigatorUsd : undefined;

type Deps = {
	store: Pick<Store, "events" | "wakes">;
	cfg: OverheadConfig;
	/** Threads Chamberlain runs itself: pinned, butlers, investigators. They are never managed threads. */
	own: readonly string[];
	query?: RunQuery;
};
type Notes = { unavailable: string[]; notConfigured: string[] };

/** The managed threads' figures for [from, to). */
export async function readManaged(
	d: Deps,
	span: { from: number; to: number },
	causedUsd: number | undefined,
	notes: Notes,
): Promise<ManagedSection> {
	if (d.cfg.fleet.source === "off") {
		notes.notConfigured.push('managed overhead: overhead.fleet.source is "off", so the threads\' spend cannot be read');
		return { status: "not-configured" };
	}
	try {
		const events = d.store.events.query({
			events: ["fire"],
			since: new Date(span.from).toISOString(),
			until: new Date(span.to).toISOString(),
			limit: 100_000,
		});
		const members = [...d.store.wakes.rows("all").flatMap((r) => r.members), ...d.store.wakes.held()];
		const threads = managedThreads({ events, members, own: new Set(d.own), ...span });
		const rows = await managedSpend(
			d.cfg,
			threads.map((t) => t.id),
			span,
			d.query,
		);
		const report = joinManaged(threads, rows);
		return {
			status: "ok",
			report,
			...(causedUsd !== undefined ? { causedUsd } : {}),
			...managedFigures(causedUsd, report),
		};
	} catch (e) {
		notes.unavailable.push(`managed threads: unavailable (${errClass(e)})`);
		return { status: "unavailable" };
	}
}

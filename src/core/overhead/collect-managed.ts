/**
 * The inputs that need LifeOS and Chamberlain's thread records: the spend of the threads Chamberlain LAUNCHED (its butlers and investigators, named by
 * its own launch records), and the managed overhead ratio (which threads it supervised, managed.ts, over what their sessions spent,
 * managed-spend.ts). A read that fails is "unavailable", and the line that says so carries a fixed error class, never the tool's text.
 */
import { errClass } from "../obs/fields.ts";
import type { Store } from "../store/store.ts";
import type { OverheadConfig } from "./config.ts";
import type { RunQuery } from "./fleet-spend.ts";
import { joinManaged, type ManagedReport, managedFigures, managedThreads, type OwnThreads } from "./managed.ts";
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

/** What the threads Chamberlain launched spent in the window, found by the thread ids in its own records. */
export type LaunchedSpend = {
	butlers: number;
	investigators: number;
	butlersUsd: number;
	investigatorsUsd: number;
	/** Launched threads with no LifeOS session: their spend is unknown and not in the figures. */
	unmapped: number;
};

type Notes = { unavailable: string[]; notConfigured: string[] };
type Source = { cfg: OverheadConfig; own: OwnThreads; query?: RunQuery };
type Span = { from: number; to: number };

/**
 * What the butlers and investigators Chamberlain launched spent in [from, to): their thread ids come from the butler ledger and the overhead state,
 * and LifeOS gives the spend of the sessions that ran for those threads. Never by project or title. Undefined when LifeOS is not the spend source
 * or cannot be read; a launched thread with no session is counted as unmapped and said so, never as $0 that looks measured.
 */
async function readLaunched(d: Source, span: Span, notes: Notes): Promise<LaunchedSpend | undefined> {
	if (d.cfg.fleet.source === "off") return undefined;
	const butlers = new Set(d.own.butlers);
	const investigators = new Set(d.own.investigators);
	const ids = [...new Set([...butlers, ...investigators])];
	try {
		const rows = await managedSpend(d.cfg, ids, span, d.query);
		const sum = (of: Set<string>) => rows.filter((r) => of.has(r.id)).reduce((a, r) => a + r.usd, 0);
		const mapped = new Set(rows.map((r) => r.id));
		const unmapped = ids.filter((i) => !mapped.has(i)).length;
		if (unmapped)
			notes.unavailable.push(
				`Chamberlain-launched threads: ${unmapped} of ${ids.length} have no LifeOS session, so their spend is not counted`,
			);
		return {
			butlers: butlers.size,
			investigators: investigators.size,
			butlersUsd: sum(butlers),
			investigatorsUsd: sum(investigators),
			unmapped,
		};
	} catch (e) {
		notes.unavailable.push(`Chamberlain-launched threads: unavailable (${errClass(e)})`);
		return undefined;
	}
}

/** Chamberlain-caused spend: the Steward and its own calls, plus the butlers and investigators it launched. Undefined when any part is unknown. */
const causedUsdOf = (day: WindowMetrics, launched: LaunchedSpend | undefined): number | undefined =>
	launched && usable(day.basisUsd) ? day.basisUsd + launched.butlersUsd + launched.investigatorsUsd : undefined;

type Deps = Source & { store: Pick<Store, "events" | "wakes"> };

/** The launched threads' spend, the Chamberlain-caused spend that builds on it, and the managed ratio over it. */
export async function readSupervision(d: Deps, span: Span, day: WindowMetrics, notes: Notes) {
	const launched = await readLaunched(d, span, notes);
	const causedUsd = causedUsdOf(day, launched);
	return { launched, causedUsd, managed: await readManaged(d, span, causedUsd, notes) };
}

/** The managed threads' figures for [from, to). */
async function readManaged(d: Deps, span: Span, causedUsd: number | undefined, notes: Notes): Promise<ManagedSection> {
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
		const own = new Set([...d.own.pinned, ...d.own.butlers, ...d.own.investigators]);
		const threads = managedThreads({ events, members, own, ...span });
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

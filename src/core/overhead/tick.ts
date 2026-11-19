/**
 * The overhead tick: once per `checkEveryHours`, the daemon measures, keeps the numbers for the Decisions view, and, when a limit is crossed
 * and the guards in trigger.ts allow it, opens an investigator thread. The thread is started through `launch`, which the daemon gives it (the T3
 * adapter, src/adapters/t3/investigator.ts); this module never talks to T3 itself.
 *
 * A launch that fails records itself as closed ("launch-failed"), which holds neither the cooldown nor the open slot, so the next interval
 * tries again. Nothing here restarts, deploys or edits anything: it measures, records and asks for a thread.
 */
import { randomBytes } from "node:crypto";
import type { GhRead } from "../decide/hold-lookup.ts";
import type { Store } from "../store/store.ts";
import { type BriefCommands, investigatorBrief } from "./brief.ts";
import { collect } from "./collect.ts";
import { HOUR_MS, type OverheadConfig } from "./config.ts";
import type { RunQuery } from "./fleet-spend.ts";
import { summarize } from "./format.ts";
import { priceOf } from "./prices.ts";
import { decide, markChecked, readOverheadState, recordOpened, updateInvestigation } from "./trigger.ts";

/** Starts the investigator thread (its ids derived from `seed`, the investigation's id) with this title and brief and says which thread it is. Rejects when nothing was launched. */
export type Launch = (a: { seed: string; title: string; brief: string }) => Promise<{ threadId: string }>;

export type OverheadTickDeps = {
	store: Store;
	cfg: OverheadConfig;
	/** The Steward's model from `models.steward`; undefined when none is configured. */
	model?: string;
	gh: GhRead;
	query?: RunQuery;
	/** Absent: no investigator can be launched (not configured), and a crossing is only recorded. */
	launch?: Launch;
	commands: BriefCommands;
	now?: () => number;
	log: (
		event: "overhead-checked" | "overhead-investigation" | "overhead-error",
		fields: Record<string, unknown>,
	) => void;
};

const oneLine = (e: unknown) =>
	String(e instanceof Error ? e.message : e)
		.replace(/\s+/g, " ")
		.slice(0, 200);

/** Opens the investigation: records it, launches the thread, records the thread (or the failure). */
async function open(d: OverheadTickDeps, report: Awaited<ReturnType<typeof collect>>, now: number): Promise<void> {
	const id = `OV-${randomBytes(3).toString("hex")}`;
	const crossings = report.crossings.map((c) => c.detail);
	recordOpened(d.store, { id, openedAt: now, status: "open", crossings }, now, d.cfg);
	try {
		if (!d.launch) throw Error("no investigator can be launched: set overhead.investigator.model and projectId");
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
		const { threadId } = await d.launch({ seed: id, title, brief });
		updateInvestigation(d.store, id, { threadId });
		d.log("overhead-investigation", { id, thread: threadId, crossings: crossings.length });
	} catch (e) {
		updateInvestigation(d.store, id, { status: "closed", closedAt: now, closedBy: "launch-failed", note: oneLine(e) });
		d.log("overhead-error", { stage: "launch", id, error: oneLine(e) });
	}
}

/** One daemon owns this tick. It measures at most once per `checkEveryHours`; a restart does not measure again early. */
export function overheadTicker(d: OverheadTickDeps) {
	let busy = false;
	return async () => {
		const now = (d.now ?? Date.now)();
		const prior = readOverheadState(d.store);
		const every = d.cfg.checkEveryHours * HOUR_MS;
		if (busy || (prior.lastCheckAt !== undefined && now - prior.lastCheckAt < every)) return;
		busy = true;
		try {
			const report = await collect({
				store: d.store,
				cfg: d.cfg,
				...(d.model ? { model: d.model } : {}),
				gh: d.gh,
				...(d.query ? { query: d.query } : {}),
				now,
			});
			markChecked(d.store, now, summarize(report));
			const decision = decide({ crossings: report.crossings, state: readOverheadState(d.store), now, cfg: d.cfg });
			d.log("overhead-checked", {
				crossings: report.crossings.length,
				opened: decision.open,
				...(decision.open || decision.reason === "no-crossing" ? {} : { skipped: decision.reason }),
			});
			if (decision.open) await open(d, report, now);
		} finally {
			busy = false;
		}
	};
}

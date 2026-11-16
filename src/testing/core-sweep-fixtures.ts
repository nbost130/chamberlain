import { type ItemSource, runSources } from "../core/items/source.ts";
import { type SweepAction, sweepAction } from "../core/sweep/sweep.ts";
import type { memStore } from "./store.ts";

const SOON = 60_000;

/** A source that reports what the test says, as a check would. */
export const src = (
	name: string,
	findings: () => { dedupKey: string; text: string; repeatIntervalMs?: number; baseline?: boolean }[] | Error,
	mode?: "silenced" | "shadow" | "live",
): ItemSource => ({
	name,
	...(mode ? { mode } : {}),
	run: async () => {
		const f = findings();
		if (f instanceof Error) throw f;
		return f;
	},
});

/** One sweep over the sources, through the item system, as the engine does it. */
export async function sweep(
	store: ReturnType<typeof memStore>,
	sources: ItemSource[],
	o: { now?: number; firstRun?: boolean; sinceFullMs?: number } = {},
): Promise<SweepAction> {
	return sweepAction(
		await runSources(store, sources, { now: o.now ?? 0, firstRun: o.firstRun ?? false }),
		o.sinceFullMs ?? SOON,
	);
}

export const ready = (title: string, dedupKey = "pr:7:abc") => [
	{ dedupKey, text: `PR 7 (${title}) is ready to land.` },
];

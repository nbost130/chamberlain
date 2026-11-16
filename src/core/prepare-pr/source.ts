/**
 * Built-in ItemSources for prepare-pr: one-way urgent vs other gates (independent modes).
 */
import type { Finding, ItemSource } from "../items/source.ts";
import type { PreparePrConfig } from "./config.ts";
import { PREPARE_PR, PREPARE_PR_OTHER } from "./config.ts";
import type { PreparePrKindFilter, PreparePrLink } from "./findings.ts";
import { type PollOptions, pollPreparePr } from "./poll.ts";

export type PreparePrPollDeps = {
	cfg: PreparePrConfig;
	listRunning: (workingPath: string) => string[];
	parkedSinceOf: (runIds: readonly string[]) => Map<string, number>;
	links: () => readonly PreparePrLink[];
	settledThreadIds: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
	exec?: PollOptions["exec"];
};

async function runKind(deps: PreparePrPollDeps, kinds: PreparePrKindFilter): Promise<readonly Finding[]> {
	const settled = await deps.settledThreadIds();
	return pollPreparePr({
		repos: deps.cfg.repos,
		listRunning: deps.listRunning,
		parkedSinceOf: deps.parkedSinceOf,
		links: [...deps.links()],
		settledThreadIds: settled,
		kinds,
		...(deps.exec ? { exec: deps.exec } : {}),
	});
}

/** Source `check:prepare-pr`: one-way-door urgent findings only. */
export function preparePrOneWaySource(deps: PreparePrPollDeps): ItemSource {
	return {
		name: `check:${PREPARE_PR}`,
		mode: deps.cfg.oneWayMode,
		run: () => runKind(deps, "one-way"),
	};
}

/** Source `check:prepare-pr-other`: other gates + settled-mismatch. */
export function preparePrOtherSource(deps: PreparePrPollDeps): ItemSource {
	return {
		name: `check:${PREPARE_PR_OTHER}`,
		mode: deps.cfg.otherMode,
		run: () => runKind(deps, "other"),
	};
}

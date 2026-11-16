/**
 * Discover helpers for prepare-pr (pure; no bun:sqlite).
 * Live state.sqlite reads live in src/prepare-pr-nm-state.ts (outside core).
 */
import { parseAxiOverviewActiveRunIds } from "./axi-parse.ts";

export type RepoTarget = { name: string; path: string };

/** Default v1 target: MemberHero on Mithrandir. */
export const DEFAULT_REPOS: readonly RepoTarget[] = [{ name: "MemberHero", path: "/home/nbost/dev/MemberHero" }];

export const DEFAULT_NO_MISTAKES_STATE = `${process.env.HOME ?? ""}/.no-mistakes/state.sqlite`;

/** Merge state.sqlite ids with axi overview ids (deduped, state first). */
export function mergeActiveRunIds(fromDb: readonly string[], fromAxi: readonly string[]): string[] {
	const out: string[] = [];
	for (const id of [...fromDb, ...fromAxi]) if (!out.includes(id)) out.push(id);
	return out;
}

/** Parse axi overview stdout into run ids (thin wrapper for tests). */
export const activeRunIdsFromAxiOverview = parseAxiOverviewActiveRunIds;

/**
 * Discover helpers for prepare-pr (pure; no bun:sqlite).
 * Live state.sqlite reads live in src/prepare-pr-nm-state.ts (outside core).
 */
import { parseAxiOverviewActiveRunIds } from "./axi-parse.ts";

export type RepoTarget = { name: string; path: string };

/** Default v1 target: MemberHero on Mithrandir. */
export const DEFAULT_REPOS: readonly RepoTarget[] = [{ name: "MemberHero", path: "/home/nbost/dev/MemberHero" }];

export const DEFAULT_NO_MISTAKES_STATE = `${process.env.HOME ?? ""}/.no-mistakes/state.sqlite`;

/** Merge discovery sources (deduped, first occurrence wins). Typical order: DB, AXI, open links. */
export function mergeActiveRunIds(...sources: readonly (readonly string[])[]): string[] {
	const out: string[] = [];
	for (const src of sources) for (const id of src) if (!out.includes(id)) out.push(id);
	return out;
}

/** Parse axi overview stdout into run ids (thin wrapper for tests). */
export const activeRunIdsFromAxiOverview = parseAxiOverviewActiveRunIds;

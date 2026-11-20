/**
 * The PRs merged across the repositories the Steward supervises, read once per measurement from GitHub's search (REST `search/issues`, through the
 * same `GhRead` the held-ledger reconciler uses). One search per owner or repo covers every window the report shows, so a measurement is a handful of
 * calls, well inside the search limit (30 a minute).
 *
 * A bors rollup shows up twice: the rollup PR and each PR it bundled, all marked merged. metrics.ts `countMerged` skips the rollup PR itself.
 *
 * It fails closed. GitHub's search returns at most 1000 results a query, and a read can fail: either way the count is unknown, the function
 * throws, and the report shows the PR numbers as unavailable instead of a count that is too low and would make the cost look too high.
 */
import type { GhRead } from "../decide/hold-lookup.ts";
import type { MergedPr } from "./metrics.ts";

const PER_PAGE = 100;
const MAX_RESULTS = 1000;
const JQ =
	"{total: .total_count, incomplete: .incomplete_results, items: [.items[] | {r: .repository_url, n: .number, m: .pull_request.merged_at, t: .title}]}";

type Page = { total: number; incomplete: boolean; items: { r: string; n: number; m: string | null; t: string }[] };

const isPage = (v: unknown): v is Page =>
	typeof v === "object" && v !== null && typeof (v as Page).total === "number" && Array.isArray((v as Page).items);

/** The PRs one search scope (`user:<owner>` or `repo:<owner>/<name>`) merged since `sinceMs`, every page of them. */
async function scopePrs(gh: GhRead, scope: string, sinceMs: number): Promise<MergedPr[]> {
	const q = encodeURIComponent(`is:pr is:merged ${scope} merged:>=${new Date(sinceMs).toISOString()}`);
	const out: MergedPr[] = [];
	for (let page = 1; ; page++) {
		const r = await gh(`search/issues?q=${q}&per_page=${PER_PAGE}&page=${page}`, JQ);
		if (!isPage(r)) throw Error(`GitHub search for ${scope} gave an unexpected reply`);
		if (r.total > MAX_RESULTS)
			throw Error(`${scope} merged ${r.total} PRs in the window, more than GitHub's search returns`);
		if (r.incomplete) throw Error(`GitHub's search for ${scope} was incomplete`);
		for (const i of r.items)
			if (i.m) out.push({ repo: i.r.replace(/^.*\/repos\//, ""), number: i.n, mergedAt: Date.parse(i.m), title: i.t });
		if (r.items.length < PER_PAGE || page * PER_PAGE >= r.total) return out;
	}
}

/** Every PR the owners and repos merged since `sinceMs` (a repo of a named owner is read twice and counted once, by metrics.ts). Any scope that cannot be read in full rejects the whole read. */
export async function mergedPrs(
	gh: GhRead,
	g: { owners: readonly string[]; repos: readonly string[] },
	sinceMs: number,
): Promise<MergedPr[]> {
	const scopes = [...g.owners.map((o) => `user:${o}`), ...g.repos.map((r) => `repo:${r}`)];
	return (await Promise.all(scopes.map((s) => scopePrs(gh, s, sinceMs)))).flat();
}

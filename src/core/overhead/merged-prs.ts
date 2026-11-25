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
import { SAFE_REPO } from "./config-names.ts";
import type { MergedPr } from "./metrics.ts";

const PER_PAGE = 100;
const MAX_RESULTS = 1000;
const JQ =
	"{total: .total_count, incomplete: .incomplete_results, items: [.items[] | {r: .repository_url, n: .number, m: .pull_request.merged_at, t: .title}]}";

type Page = { total: number; incomplete: boolean; items: unknown[] };

const isPage = (v: unknown): v is Page =>
	typeof v === "object" &&
	v !== null &&
	Number.isSafeInteger((v as Page).total) &&
	(v as Page).total >= 0 &&
	typeof (v as Page).incomplete === "boolean" &&
	Array.isArray((v as Page).items);

function parsePr(value: unknown): MergedPr {
	const { r, n, m, t } = (value ?? {}) as Record<string, unknown>;
	const repo = typeof r === "string" ? r.match(/^https?:\/\/[^/]+\/(?:.*\/)?repos\/(.+)$/)?.[1] : undefined;
	const mergedAt = typeof m === "string" ? Date.parse(m) : Number.NaN;
	if (
		!repo ||
		!SAFE_REPO.test(repo) ||
		typeof n !== "number" ||
		!Number.isSafeInteger(n) ||
		n < 1 ||
		!Number.isFinite(mergedAt) ||
		typeof t !== "string"
	)
		throw Error("GitHub search returned an unreadable merged PR");
	return { repo, number: n, mergedAt, title: t };
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The PRs in one search scope, every page of them. The caller applies the exact half-open bounds. */
async function scopePrs(gh: GhRead, scope: string, sinceMs: number, untilMs?: number): Promise<MergedPr[]> {
	const since = new Date(sinceMs).toISOString();
	const range = untilMs === undefined ? `>=${since}` : `${isoSeconds(sinceMs)}..${isoSeconds(untilMs)}`;
	const q = encodeURIComponent(`is:pr is:merged ${scope} merged:${range}`);
	const out = new Map<string, MergedPr>();
	let total: number | undefined;
	for (let page = 1; ; page++) {
		const r = await gh(`search/issues?q=${q}&per_page=${PER_PAGE}&page=${page}`, JQ);
		if (!isPage(r)) throw Error(`GitHub search for ${scope} gave an unexpected reply`);
		if (r.total > MAX_RESULTS)
			throw Error(`${scope} merged ${r.total} PRs in the window, more than GitHub's search returns`);
		if (r.incomplete) throw Error(`GitHub's search for ${scope} was incomplete`);
		total ??= r.total;
		if (r.total !== total || r.items.length !== Math.min(PER_PAGE, total - out.size))
			throw Error(`GitHub's search for ${scope} returned an incomplete page`);
		addPage(out, r.items);
		if (out.size === total) return [...out.values()];
	}
}

function addPage(out: Map<string, MergedPr>, items: unknown[]): void {
	for (const entry of items) {
		const p = parsePr(entry);
		const key = `${p.repo.toLowerCase()}#${p.number}`;
		if (out.has(key)) throw Error("GitHub search repeated a merged PR");
		out.set(key, p);
	}
}

/** Every PR the owners and repos merged since `sinceMs` (a repo of a named owner is read twice and counted once, by metrics.ts). Any scope that cannot be read in full rejects the whole read. */
export async function mergedPrs(
	gh: GhRead,
	g: { owners: readonly string[]; repos: readonly string[] },
	sinceMs: number,
	untilMs?: number,
): Promise<MergedPr[]> {
	const scopes = [...g.owners.map((o) => `user:${o}`), ...g.repos.map((r) => `repo:${r}`)];
	return (await Promise.all(scopes.map((s) => scopePrs(gh, s, sinceMs, untilMs)))).flat();
}

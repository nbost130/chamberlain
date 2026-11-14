/** The GitHub half of the ref pass (./hold-reconcile.ts): what one PR, issue or branch ref says of its hold. */

/** What a lookup learned. `live` means the thing is still going, so the hold stays. `unknown` stays too, and says why. */
export type Seen = { state: "done"; saw: string } | { state: "live" } | { state: "unknown"; why: string };
/** A GitHub read: the API path, a jq filter, the parsed result. Rejects on any failure. */
export type GhRead = (path: string, jq: string) => Promise<unknown>;

/** Where a branch was first seen to exist. `repoId` is written once and never changed; any later different id sets `conflict`, and the ref is unknown for good. */
export type Sighting = { t: number; repoId: number; conflict?: boolean };

const stamp = (v: unknown) =>
	typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) ? `${v.slice(0, 16)}Z` : undefined;
const parts = (ref: string) => {
	const [, owner, repo, tail] = ref.match(/^([^/]+)\/([^#:]+)[#:](.+)$/) ?? [];
	return owner !== undefined && repo !== undefined && tail !== undefined ? { owner, repo, tail } : undefined;
};

type RepoRef = { owner: string; repo: string; tail: string };
export type GitHubKind = "pr" | "issue" | "branch";

async function lookupPr(value: string, base: string, p: RepoRef, gh: GhRead): Promise<Seen> {
	const r = (await gh(`${base}/pulls/${p.tail}`, "{state:.state,merged_at:.merged_at,closed_at:.closed_at}")) as {
		state?: unknown;
		merged_at?: unknown;
		closed_at?: unknown;
	} | null;
	if (r?.state === "open") return { state: "live" };
	if (r?.state === "closed") {
		const merged = stamp(r.merged_at);
		if (merged) return { state: "done", saw: `PR ${value} merged ${merged}` };
		const closed = stamp(r.closed_at);
		if (closed && !r.merged_at) return { state: "done", saw: `PR ${value} closed ${closed}` };
	}
	return { state: "unknown", why: "PR state not readable" };
}

async function lookupIssue(value: string, base: string, p: RepoRef, gh: GhRead): Promise<Seen> {
	const r = (await gh(`${base}/issues/${p.tail}`, "{state:.state,closed_at:.closed_at,pr:(.pull_request!=null)}")) as {
		state?: unknown;
		closed_at?: unknown;
		pr?: unknown;
	} | null;
	if (r?.pr !== false) return { state: "unknown", why: "reference is a pull request or unreadable" };
	if (r.state === "open") return { state: "live" };
	const closed = stamp(r.closed_at);
	if (r.state === "closed" && closed) return { state: "done", saw: `issue ${value} closed ${closed}` };
	return { state: "unknown", why: "issue state not readable" };
}

/**
 * Whether the repository answering now is the one the branch was first seen on; undefined when it is. The id is written once, at
 * the first sighting, and never replaced. A later different id (a recreated or transferred repository under the same name) marks the
 * ref in conflict for good: seeing the branch there cannot make it the old one again.
 */
function repoMismatch(
	seen: Sighting | undefined,
	repo: { id: number; full_name: string },
	p: RepoRef,
): Seen | undefined {
	if (seen && (seen.conflict || seen.repoId !== repo.id)) {
		seen.conflict = true;
		return { state: "unknown", why: `repository id changed from ${seen.repoId} to ${repo.id}` };
	}
	if (repo.full_name.toLowerCase() !== `${p.owner}/${p.repo}`.toLowerCase())
		return { state: "unknown", why: `repository now answers as ${repo.full_name}` };
	return undefined;
}

// A branch is known deleted only on the same repository it was seen on. A slug can be transferred, renamed or recreated, so
// the repository's numeric id is recorded when the branch is first seen, and an absent branch counts only when that same id
// answers under the same name. A redirect (a different name back) or a different id is unknown, never deleted.
async function lookupBranch(
	{ value, base, p }: { value: string; base: string; p: RepoRef },
	gh: GhRead,
	{ seenLive, now }: Seeing,
): Promise<Seen> {
	const repo = (await gh(base, "{id:.id,full_name:.full_name}")) as { id?: unknown; full_name?: unknown } | null;
	if (typeof repo?.id !== "number" || !Number.isInteger(repo.id) || typeof repo.full_name !== "string")
		return { state: "unknown", why: "repository identity not readable" };
	const seen = seenLive[value];
	const mismatch = repoMismatch(seen, { id: repo.id, full_name: repo.full_name }, p);
	if (mismatch) return mismatch;
	// matching-refs answers an empty list, not a 404, for a branch that is not there, so "gone" is never confused with "no access".
	const r = await gh(
		`${base}/git/matching-refs/heads/${p.tail}?per_page=100`,
		`[.[]|select(.ref==${JSON.stringify(`refs/heads/${p.tail}`)})]|length`,
	);
	if (typeof r !== "number" || !Number.isInteger(r) || r < 0)
		return { state: "unknown", why: "branch answer not readable" };
	if (r > 0) {
		seenLive[value] = { t: now, repoId: seen?.repoId ?? repo.id };
		return { state: "live" };
	}
	if (!seen || typeof seen.repoId !== "number")
		return { state: "unknown", why: "branch never seen on the remote, so not known to be deleted" };
	return {
		state: "done",
		saw: `branch ${value} no longer on the remote (repo id ${repo.id}, last seen ${new Date(seen.t).toISOString().slice(0, 16)}Z)`,
	};
}

/** Where branches were seen to exist (updated by a lookup) and when this pass is. */
type Seeing = { seenLive: Record<string, Sighting>; now: number };

export async function lookup(kind: GitHubKind, value: string, gh: GhRead, seeing: Seeing): Promise<Seen> {
	const p = parts(value);
	if (!p) return { state: "unknown", why: "malformed ref" };
	const base = `repos/${p.owner}/${p.repo}`;
	if (kind === "pr") return lookupPr(value, base, p, gh);
	if (kind === "issue") return lookupIssue(value, base, p, gh);
	return lookupBranch({ value, base, p }, gh, seeing);
}

/** SQL accessors for prepare-pr thread↔run links (migration 18). */
import type { Db, Row } from "./sqlite-db.ts";
import type { PreparePrLinkRow, PreparePrLinkStore } from "./store-prepare-pr-links.ts";

const toRow = (r: Row): PreparePrLinkRow => ({
	threadId: r.thread_id as string,
	runId: r.run_id as string,
	repo: r.repo as string,
	startedAt: r.started_at as number,
	clearedAt: (r.cleared_at as number | null) ?? null,
});

export const makePreparePrLinks = (c: Db): PreparePrLinkStore => ({
	link(threadId, runId, repo, now = Date.now()) {
		const existing = c.one("SELECT * FROM prepare_pr_links WHERE thread_id = ? AND run_id = ?", threadId, runId);
		if (existing && existing.cleared_at == null && (existing.repo as string) === repo) return false;
		c.run(
			`INSERT INTO prepare_pr_links (thread_id, run_id, repo, started_at, cleared_at)
			 VALUES (?, ?, ?, ?, NULL)
			 ON CONFLICT (thread_id, run_id) DO UPDATE SET
			 	repo = excluded.repo,
			 	started_at = CASE WHEN prepare_pr_links.cleared_at IS NULL THEN prepare_pr_links.started_at ELSE excluded.started_at END,
			 	cleared_at = NULL`,
			threadId,
			runId,
			repo,
			now,
		);
		return true;
	},
	clear(threadId, runId, now = Date.now()) {
		return (
			c.run(
				"UPDATE prepare_pr_links SET cleared_at = ? WHERE thread_id = ? AND run_id = ? AND cleared_at IS NULL",
				now,
				threadId,
				runId,
			).changes > 0
		);
	},
	get(threadId, runId) {
		const r = c.one("SELECT * FROM prepare_pr_links WHERE thread_id = ? AND run_id = ?", threadId, runId);
		return r ? toRow(r) : undefined;
	},
	listOpen(repo) {
		if (repo !== undefined)
			return c
				.all("SELECT * FROM prepare_pr_links WHERE cleared_at IS NULL AND repo = ? ORDER BY started_at", repo)
				.map(toRow);
		return c.all("SELECT * FROM prepare_pr_links WHERE cleared_at IS NULL ORDER BY started_at").map(toRow);
	},
});

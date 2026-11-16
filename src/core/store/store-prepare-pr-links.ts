/** prepare-pr thread↔run link rows (migration 18). */
export type PreparePrLinkRow = {
	threadId: string;
	runId: string;
	repo: string;
	startedAt: number;
	clearedAt: number | null;
};

export interface PreparePrLinkStore {
	/** Insert or refresh an open link (clears cleared_at). Returns false if the same open row already existed unchanged. */
	link(threadId: string, runId: string, repo: string, now?: number): boolean;
	/** Mark cleared_at; no-op if missing or already cleared. */
	clear(threadId: string, runId: string, now?: number): boolean;
	get(threadId: string, runId: string): PreparePrLinkRow | undefined;
	/** Open links (cleared_at IS NULL), optionally filtered by repo. */
	listOpen(repo?: string): PreparePrLinkRow[];
}

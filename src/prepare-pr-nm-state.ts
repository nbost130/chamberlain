/**
 * Read-only access to no-mistakes `state.sqlite` for prepare-pr discovery.
 * Lives outside `src/core/` so the Store remains the only chamberlain.db opener in core.
 */
import { Database } from "bun:sqlite";

/** List running run ids for a working_path. Returns [] when the file is missing or unreadable. */
export function listRunningRunIdsFromStateDb(dbPath: string, workingPath: string): string[] {
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query(
					`SELECT r.id AS id
					 FROM runs r
					 JOIN repos p ON p.id = r.repo_id
					 WHERE r.status = 'running' AND p.working_path = ?
					 ORDER BY r.updated_at DESC`,
				)
				.all(workingPath) as { id: string }[];
			return rows.map((r) => r.id);
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

/** awaiting_agent_since keyed by run id, normalized to epoch ms. */
export function parkedSinceFromStateDb(dbPath: string, runIds: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (!runIds.length) return out;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			for (const id of runIds) {
				const row = db.query(`SELECT awaiting_agent_since AS s FROM runs WHERE id = ?`).get(id) as {
					s: number | null;
				} | null;
				if (row?.s == null) continue;
				out.set(id, row.s < 1e12 ? row.s * 1000 : row.s);
			}
		} finally {
			db.close();
		}
	} catch {
		/* ignore */
	}
	return out;
}

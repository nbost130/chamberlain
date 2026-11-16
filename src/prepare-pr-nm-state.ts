/**
 * Read-only access to no-mistakes `state.sqlite` for prepare-pr discovery.
 * Lives outside `src/core/` so the Store remains the only chamberlain.db opener in core.
 * Fail closed: open/query errors throw (never silent empty that would clear findings).
 *
 * Discovery uses the configured working_path only to resolve repository identity (`upstream_url`),
 * then lists every running run for that identity across all checkouts (temp agent paths included).
 */
import { Database } from "bun:sqlite";
import { accessSync, constants } from "node:fs";

function requireReadableDb(dbPath: string): void {
	try {
		accessSync(dbPath, constants.R_OK);
	} catch (e) {
		throw Error(`no-mistakes state.sqlite unreadable at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function openReadonly(dbPath: string): Database {
	requireReadableDb(dbPath);
	try {
		return new Database(dbPath, { readonly: true });
	} catch (e) {
		throw Error(`no-mistakes state.sqlite open failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function rethrowDbQueryError(e: unknown): never {
	if (e instanceof Error && e.message.startsWith("no-mistakes state.sqlite")) throw e;
	throw Error(`no-mistakes state.sqlite query failed: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * Running run ids for the repository identity of `workingPath` (all checkouts sharing its upstream_url).
 * Throws when the file is missing, unreadable, or the configured path is unknown.
 */
export function listRunningRunIdsFromStateDb(dbPath: string, workingPath: string): string[] {
	const db = openReadonly(dbPath);
	try {
		const identity = db.query(`SELECT upstream_url AS u FROM repos WHERE working_path = ?`).get(workingPath) as {
			u: string;
		} | null;
		if (!identity?.u) throw Error(`no-mistakes state.sqlite has no repo for working_path ${workingPath}`);
		const rows = db
			.query(
				`SELECT r.id AS id
				 FROM runs r
				 JOIN repos p ON p.id = r.repo_id
				 WHERE r.status = 'running' AND p.upstream_url = ?
				 ORDER BY r.updated_at DESC`,
			)
			.all(identity.u) as { id: string }[];
		return rows.map((r) => r.id);
	} catch (e) {
		rethrowDbQueryError(e);
	} finally {
		db.close();
	}
}

/** awaiting_agent_since keyed by run id, normalized to epoch ms. Throws when the DB is unreadable. */
export function parkedSinceFromStateDb(dbPath: string, runIds: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (!runIds.length) return out;
	const db = openReadonly(dbPath);
	try {
		for (const id of runIds) {
			const row = db.query(`SELECT awaiting_agent_since AS s FROM runs WHERE id = ?`).get(id) as {
				s: number | null;
			} | null;
			if (row?.s == null) continue;
			out.set(id, row.s < 1e12 ? row.s * 1000 : row.s);
		}
	} catch (e) {
		rethrowDbQueryError(e);
	} finally {
		db.close();
	}
	return out;
}

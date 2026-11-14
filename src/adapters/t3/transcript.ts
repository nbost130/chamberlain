/**
 * Where the Steward's Claude Code transcript is, for the health check. T3 keeps which provider session a thread runs in
 * its state database, and the session's working directory names Claude Code's project folder. Only a Claude Code
 * Steward has such a transcript: any other provider is reported as unavailable, never as healthy.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Transcript } from "../../core/adapter.ts";
import { thread as stewardThread } from "../../core/layout.ts";

export function resolveSteward(dbPath: string, conf: string): { thread: string; session: string; project: string } {
	const thread = stewardThread(conf, "steward");
	if (!thread) throw Error("no Steward thread is set (threads.steward in config.json)");
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query(`select p.payload_json, s.payload_json as session_json from orchestration_v2_projection_threads t
			join orchestration_v2_projection_provider_threads p on p.provider_thread_id=t.active_provider_thread_id
			join orchestration_v2_projection_provider_sessions s on s.provider_session_id=p.provider_session_id where t.thread_id=?`)
			.get(thread) as { payload_json: string; session_json: string } | null;
		if (!row) throw Error("active Steward provider thread unavailable");
		const p = JSON.parse(row.payload_json),
			s = JSON.parse(row.session_json);
		const session = p.nativeThreadRef?.nativeId;
		if (
			p.nativeThreadRef?.driver !== "claudeAgent" ||
			!/^[a-f0-9-]{36}$/i.test(session ?? "") ||
			typeof s.cwd !== "string" ||
			!s.cwd.startsWith("/")
		)
			throw Error("Steward Claude identity unavailable");
		return { thread, session, project: s.cwd.replace(/[^a-zA-Z0-9]/g, "-") };
	} finally {
		db.close();
	}
}

/** The Steward's reads of a thread in T3: its `t3_thread_read` tool, and `peek.ts` run from a shell. */
export function threadReadKey(tool: string, input: Record<string, any>): string | undefined {
	if (tool.endsWith("t3_thread_read") && typeof input.threadId === "string")
		return `${input.environmentId ?? "local"}:${input.threadId}`;
	if (tool === "Bash") {
		const m = String(input.command ?? "").match(/\bpeek\.ts\s+([\w-]+)\s+([\w:-]+)/);
		if (m) return `${m[1]}:${m[2]}`;
	}
	return undefined;
}

export async function t3Transcript(o: { dbPath: string; conf: string; claudeDir?: string }): Promise<Transcript> {
	const id = resolveSteward(o.dbPath, o.conf);
	const claudeDir = o.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`;
	return {
		path: `${claudeDir}/projects/${id.project}/${id.session}.jsonl`,
		session: id.session,
		thread: id.thread,
		threadReadKey,
	};
}

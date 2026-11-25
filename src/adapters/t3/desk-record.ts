/** The Alert Desk as T3's state database records it: which provider its next turn runs on, and what its finished turns ran. Read-only. */
import { Database } from "bun:sqlite";
import type { DeskCall, DeskTurn, DeskTurns, ReadDeskTurns } from "../../core/adapter/adapter-desk.ts";
import { type DeskHookEnv, deskHook } from "./desk-hook.ts";

/** The driver whose PreToolUse hooks block a call. A driver with no proven control is not listed: the desk is held on it. */
const HOOK_DRIVER = "claudeAgent";
const MAX_ITEMS = 2_000;
const DONE = new Set(["completed", "failed", "interrupted", "cancelled"]);

const DESK = `select json_extract(payload_json, '$.modelSelection.instanceId') as instance,
	coalesce(json_extract(payload_json, '$.worktreePath'), (
		select workspace_root from projection_projects where project_id = json_extract(t.payload_json, '$.projectId')
	)) as root
	from orchestration_v2_projection_threads t where thread_id = ?`;
const DRIVERS = `select distinct driver from orchestration_v2_projection_provider_threads where provider_instance_id = ?`;
/** The desk's own turns and those of the gatherers it started, which run in threads of their own. */
const TURNS = `select provider_turn_id as id, completed_at as at
	from orchestration_v2_projection_provider_turns
	where (thread_id = ?1 or thread_id in (
		select child_thread_id from orchestration_v2_projection_subagents where thread_id = ?1 and child_thread_id is not null
	))
	and completed_at <= ?4 and (completed_at > ?2 or (completed_at = ?2 and provider_turn_id > ?3))
	order by completed_at, provider_turn_id limit ?5`;
const ITEMS = `select type, status, payload_json as payload from orchestration_v2_projection_turn_items
	where provider_turn_id = ? limit ${MAX_ITEMS + 1}`;

type Row = { type: string; status: string; payload: string };
type Payload = { input?: unknown; output?: unknown; toolName?: unknown };

function withDb<T>(path: string, read: (db: Database) => T): T | undefined {
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		return read(db);
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

type Desk = { instance: string | null; root: string | null };
const deskOf = (db: Database, id: string) => db.query<Desk, [string]>(DESK).get(id);

/** The hook's environment when the desk's next turn runs where the allowlist is enforced; undefined when that is not proven. */
export function deskEnforced(
	path: string,
	threadId: string | undefined,
	hook: (root: string) => DeskHookEnv | undefined = (root) => deskHook(root),
): DeskHookEnv | undefined {
	if (!threadId) return undefined;
	return withDb(path, (db) => {
		const desk = deskOf(db, threadId);
		if (!desk?.instance || !desk.root) return undefined;
		const drivers = db.query<{ driver: string | null }, [string]>(DRIVERS).all(desk.instance);
		// One driver for this provider in all of T3's history. None, or two, does not say which one runs next.
		return drivers.length === 1 && drivers[0]?.driver === HOOK_DRIVER ? hook(desk.root) : undefined;
	});
}

/** The hook's own refusal. The text must be the whole start of the output: a command that ran gives its own output first. */
const refusedByHook = (p: Payload) =>
	typeof p.output === "string" &&
	p.output.startsWith("Error: PreToolUse:") &&
	p.output.includes("alert desk allowlist: refused");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A recorded item as the tool call the allowlist would have seen: undefined when it is no call, "unreadable" when the record does not say enough. */
function callOf(type: string, p: Payload): DeskCall | "unreadable" | undefined {
	if (type === "command_execution")
		return typeof p.input === "string" ? { tool: "Bash", input: { command: p.input } } : "unreadable";
	if (type === "file_change") return { tool: "Write", input: {} };
	if (type === "web_search") return { tool: "WebSearch", input: {} };
	// A search is recorded without its directory, and a gatherer without its agent type.
	if (type === "file_search" || type === "subagent") return "unreadable";
	if (type !== "dynamic_tool") return undefined;
	if (typeof p.toolName !== "string" || !isObj(p.input)) return "unreadable";
	const { path, ...input } = p.input;
	// Some drivers name a read's file `path`.
	return {
		tool: p.toolName,
		input: p.toolName === "Read" && input.file_path === undefined ? { ...input, file_path: path } : p.input,
	};
}

function addItem(turn: DeskTurn, { type, status, payload }: Row): void {
	let p: Payload;
	try {
		p = JSON.parse(payload) as Payload;
	} catch {
		turn.unreadable++;
		return;
	}
	const call = callOf(type, p);
	if (!call) return;
	if (!DONE.has(status) || call === "unreadable") turn.unreadable++;
	else if (status === "failed" && refusedByHook(p)) turn.refused++;
	else turn.ran.push(call);
}

export function deskTurns(
	path: string,
	threadId: string | undefined,
	{ after, until, limit }: Parameters<ReadDeskTurns>[0],
): DeskTurns | undefined {
	if (!threadId) return undefined;
	return withDb(path, (db) => {
		const desk = deskOf(db, threadId);
		if (!desk) return undefined;
		const rows = db
			.query<{ id: string; at: string }, [string, string, string, string, number]>(TURNS)
			.all(threadId, after.at, after.id, until, limit);
		const turns = rows.map(({ id, at }) => {
			const items = db.query<Row, [string]>(ITEMS).all(id);
			const turn: DeskTurn = { id, at, ran: [], refused: 0, unreadable: items.length > MAX_ITEMS ? 1 : 0, items: 0 };
			turn.items = items.length;
			for (const item of items.slice(0, MAX_ITEMS)) addItem(turn, item);
			return turn;
		});
		return { turns, env: (desk.root && deskHook(desk.root)) || {} };
	});
}

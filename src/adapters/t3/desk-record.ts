/** The Alert Desk as T3's state database records it: the project its turns run in, and what its finished turns ran. Read-only and bounded. */
import { Database } from "bun:sqlite";
import type { DeskCall, DeskTurn, DeskTurnRef, DeskTurns } from "../../core/adapter/adapter-desk.ts";
import { type DeskHookEnv, deskHook } from "./desk-hook.ts";
import { DESK_DRIVER } from "./desk-policy.ts";

const MAX_ITEMS = 400;
const MAX_PAYLOAD = 128 * 1024;
const DONE = new Set(["completed", "failed", "interrupted", "cancelled"]);
/** Records that are not calls. A type this build does not know is not assumed to be one of them. */
const NOT_CALLS = new Set([
	"approval_request",
	"assistant_message",
	"checkpoint",
	"compaction",
	"error",
	"handoff",
	"link_request",
	"notification",
	"plan",
	"reasoning",
	"run_interrupt_request",
	"run_interrupt_result",
	"secret_request",
	"system_notice",
	"todo_list",
	"user_input_request",
	"user_message",
]);

const ROOT = `select coalesce(json_extract(payload_json, '$.worktreePath'), (
		select workspace_root from projection_projects where project_id = json_extract(t.payload_json, '$.projectId')
	)) as root from orchestration_v2_projection_threads t where thread_id = ?`;
/** The desk's own turns and those of the gatherers it started, which run in threads of their own. */
const TURNS = `select t.provider_turn_id as id, t.completed_at as at,
	(select count(*) from orchestration_v2_projection_turn_items i where i.provider_turn_id = t.provider_turn_id) as items
	from orchestration_v2_projection_provider_turns t
	where (t.thread_id = ?1 or t.thread_id in (
		select child_thread_id from orchestration_v2_projection_subagents where thread_id = ?1 and child_thread_id is not null
	)) and t.completed_at > ?2 and t.completed_at <= ?3
	order by t.completed_at, t.provider_turn_id limit ?4`;
const DRIVER = `select p.driver as driver from orchestration_v2_projection_provider_turns t
	left join orchestration_v2_projection_provider_threads p on p.provider_thread_id = t.provider_thread_id
	where t.provider_turn_id = ?`;
const ITEMS = `select type, status, case when length(payload_json) <= ${MAX_PAYLOAD} then payload_json end as payload
	from orchestration_v2_projection_turn_items where provider_turn_id = ? limit ${MAX_ITEMS + 1}`;

type Row = { type: string; status: string; payload: string | null };
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

const rootOf = (db: Database, id: string) => db.query<{ root: string | null }, [string]>(ROOT).get(id)?.root;

/** The environment the desk's hook runs with, when the project its next turn runs in has it; undefined when that is not proven. */
export function deskProjectHook(
	path: string,
	threadId: string | undefined,
	hook: (root: string) => DeskHookEnv | undefined = (root) => deskHook(root),
): DeskHookEnv | undefined {
	if (!threadId) return undefined;
	return withDb(path, (db) => {
		const root = rootOf(db, threadId);
		return root ? hook(root) : undefined;
	});
}

/**
 * The hook's own refusal. Only the driver that runs the hook writes it, and only for a tool of its own, where the text before a tool's output
 * is the driver's. Another tool's failure is whatever that tool says, so its refusal is not known from its text.
 */
function refusedByHook(row: Row, p: Payload, driver: string | null): boolean | "unknown" {
	const refusal =
		row.status === "failed" &&
		typeof p.output === "string" &&
		p.output.startsWith("Error: PreToolUse:") &&
		p.output.includes("alert desk allowlist: refused");
	if (!refusal || driver !== DESK_DRIVER) return false;
	const own =
		row.type === "command_execution" || (typeof p.toolName === "string" && /^[A-Z][A-Za-z]+$/.test(p.toolName));
	return own || "unknown";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toolCall(p: Payload): DeskCall | undefined {
	if (typeof p.toolName !== "string" || !isObj(p.input)) return undefined;
	const { path, ...input } = p.input;
	// Some drivers name a read's file `path`.
	return p.toolName === "Read" && input.file_path === undefined
		? { tool: "Read", input: { ...input, file_path: path } }
		: { tool: p.toolName, input: p.input };
}

/** A recorded item as the tool call the allowlist would have seen; undefined when the record does not say enough (a search's directory, a gatherer's type). */
function callOf(type: string, p: Payload): DeskCall | undefined {
	if (type === "command_execution" && typeof p.input === "string") return { tool: "Bash", input: { command: p.input } };
	if (type === "file_change") return { tool: "Write", input: {} };
	if (type === "web_search") return { tool: "WebSearch", input: {} };
	return type === "dynamic_tool" ? toolCall(p) : undefined;
}

function parse(payload: string | null): Payload | undefined {
	try {
		const p: unknown = JSON.parse(payload ?? "");
		return isObj(p) ? p : undefined;
	} catch {
		return undefined;
	}
}

function addItem(turn: DeskTurn, row: Row, driver: string | null): void {
	if (NOT_CALLS.has(row.type)) return;
	const p = parse(row.payload);
	const refused = p && refusedByHook(row, p, driver);
	const call = p && DONE.has(row.status) ? callOf(row.type, p) : undefined;
	if (refused === true) turn.refused++;
	else if (!call || refused === "unknown") turn.unreadable++;
	else turn.ran.push(call);
}

function readTurn(db: Database, { id }: DeskTurnRef): DeskTurn {
	const items = db.query<Row, [string]>(ITEMS).all(id);
	const driver = db.query<{ driver: string | null }, [string]>(DRIVER).get(id)?.driver ?? null;
	const turn: DeskTurn = { ran: [], refused: 0, unreadable: items.length > MAX_ITEMS ? 1 : 0 };
	for (const item of items.slice(0, MAX_ITEMS)) addItem(turn, item, driver);
	return turn;
}

/** The desk's finished turns, for the audit. */
export const deskTurns = (path: string, threadId: () => string | undefined): DeskTurns => ({
	list: ({ after, until, limit }) => {
		const id = threadId();
		return id
			? withDb(path, (db) =>
					db.query<DeskTurnRef, [string, string, string, number]>(TURNS).all(id, after, until, limit),
				)
			: undefined;
	},
	read: (ref) => withDb(path, (db) => readTurn(db, ref)),
	env: () => deskProjectHook(path, threadId()) ?? {},
});

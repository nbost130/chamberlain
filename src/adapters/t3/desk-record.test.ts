import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deskProjectHook, deskTurns } from "./desk-record.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REFUSAL = "Error: PreToolUse:Bash hook error: [hook]: alert desk allowlist: refused. not on the list";
type Item = [type: string, status: string, payload: object | string];

function world(over: { worktree?: string } = {}) {
	const dir = mkdtempSync(`${tmpdir()}/desk-record-`);
	dirs.push(dir);
	const path = `${dir}/state.sqlite`;
	const db = new Database(path);
	const p = "orchestration_v2_projection";
	db.run(`create table ${p}_threads (thread_id text, payload_json text)`);
	db.run("create table projection_projects (project_id text, workspace_root text)");
	db.run(`create table ${p}_provider_threads (provider_thread_id text, driver text)`);
	db.run(
		`create table ${p}_provider_turns (provider_turn_id text, provider_thread_id text, thread_id text, completed_at text)`,
	);
	db.run(`create table ${p}_subagents (thread_id text, child_thread_id text)`);
	db.run(
		`create table ${p}_turn_items (provider_turn_id text, type text, status text, payload_json text, updated_at text)`,
	);
	db.run(`insert into ${p}_threads values ('desk', ?)`, [
		JSON.stringify({ projectId: "pr", worktreePath: over.worktree ?? null }),
	]);
	db.run("insert into projection_projects values ('pr', '/desk')");
	db.run(`insert into ${p}_provider_threads values ('session', 'claudeAgent'), ('other', 'cursor')`);
	db.run(`insert into ${p}_subagents values ('desk', 'child'), ('someone', 'stranger'), ('desk', null)`);
	const items = (id: string, rows: Item[]) =>
		db.transaction(() => {
			for (const [type, status, payload] of rows)
				db.run(`insert into ${p}_turn_items values (?, ?, ?, ?, 't0')`, [
					id,
					type,
					status,
					typeof payload === "string" ? payload : JSON.stringify(payload),
				]);
		})();
	let session = "session";
	const turn = (id: string, thread: string, at: string | null, rows: Item[] = []) => {
		db.run(`insert into ${p}_provider_turns values (?, ?, ?, ?)`, [id, session, thread, at]);
		items(id, rows);
	};
	const runOn = (name: string) => {
		session = name;
	};
	const turns = deskTurns(path, () => "desk");
	const read = (id: string) => turns.read({ id, at: "", items: 0, rev: "" });
	return { path, db, turn, runOn, items, turns, read };
}
const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
const span = (o: object = {}) => ({ after: at(0), until: at(9), limit: 50, ...o });

test("the hook is looked for in the desk's own checkout, else its project", () => {
	const seen: string[] = [];
	const hook = (root: string) => {
		seen.push(root);
		return { DESK_LOG_DIRS: "/x" };
	};
	expect(deskProjectHook(world().path, "desk", hook)).toEqual({ DESK_LOG_DIRS: "/x" });
	expect(deskProjectHook(world({ worktree: "/tree" }).path, "desk", hook)).toBeDefined();
	expect(seen).toEqual(["/desk", "/tree"]);
	expect(deskProjectHook(world().path, "desk", () => undefined)).toBeUndefined();
	expect(deskProjectHook(world().path, undefined, hook)).toBeUndefined();
	expect(deskProjectHook(world().path, "gone", hook)).toBeUndefined();
	expect(deskProjectHook("/nowhere/state.sqlite", "desk", hook)).toBeUndefined();
	const rootless = world();
	rootless.db.run("delete from projection_projects");
	expect(deskProjectHook(rootless.path, "desk", hook)).toBeUndefined();
	const changed = world();
	changed.db.run("drop table projection_projects");
	expect(deskProjectHook(changed.path, "desk", hook)).toBeUndefined();
	expect(seen).toHaveLength(2);
});

test("a turn's records become what ran, what the hook refused and what cannot be replayed", () => {
	const w = world();
	w.turn("t1", "desk", at(1), [
		["command_execution", "completed", { input: "uptime" }],
		["command_execution", "failed", { input: "false", output: "Error: Exit code 1" }],
		["command_execution", "failed", { input: "rm x", output: REFUSAL }],
		["dynamic_tool", "failed", { toolName: "Read", input: { file_path: "/x" }, output: REFUSAL }],
		["command_execution", "completed", { input: "cat log", output: REFUSAL }],
		["command_execution", "failed", { input: "cat log", output: `Error: Exit code 1 ${REFUSAL}` }],
		["command_execution", "running", { input: "sleep 9" }],
		["command_execution", "completed", {}],
		["dynamic_tool", "completed", { toolName: "Read", input: { path: "/var/log/a" } }],
		["dynamic_tool", "completed", { toolName: "Read", input: { file_path: "/var/log/b" } }],
		["dynamic_tool", "completed", { toolName: "Grep", input: { path: "/var/log" } }],
		["dynamic_tool", "completed", { input: {} }],
		["dynamic_tool", "completed", { toolName: "Read", input: "x" }],
		["file_change", "completed", {}],
		["web_search", "completed", {}],
		["file_search", "completed", { pattern: "x" }],
		["subagent", "completed", {}],
		["dynamic_tool", "completed", "{"],
		["dynamic_tool", "completed", "[]"],
		["assistant_message", "completed", { text: "hi" }],
	]);
	expect(w.read("t1")).toEqual({
		refused: 2,
		unreadable: 8,
		ran: [
			{ tool: "Bash", input: { command: "uptime" } },
			{ tool: "Bash", input: { command: "false" } },
			{ tool: "Bash", input: { command: "cat log" } },
			{ tool: "Bash", input: { command: "cat log" } },
			{ tool: "Read", input: { file_path: "/var/log/a" } },
			{ tool: "Read", input: { file_path: "/var/log/b" } },
			{ tool: "Grep", input: { path: "/var/log" } },
			{ tool: "Write", input: {} },
			{ tool: "WebSearch", input: {} },
		],
	});
});

test("the refusal's words count only where the hook's driver writes them", () => {
	const w = world();
	const bash: Item = ["command_execution", "failed", { input: "rm x", output: REFUSAL }];
	w.runOn("other");
	w.turn("elsewhere", "desk", at(1), [bash]);
	expect(w.read("elsewhere")).toEqual({
		refused: 0,
		unreadable: 0,
		ran: [{ tool: "Bash", input: { command: "rm x" } }],
	});
	w.runOn("gone");
	w.turn("unknown-driver", "desk", at(1), [bash]);
	expect(w.read("unknown-driver")?.ran).toHaveLength(1);
	w.runOn("session");
	w.turn("another-tool", "desk", at(1), [
		["dynamic_tool", "failed", { toolName: "mcp__x__run", input: {}, output: REFUSAL }],
	]);
	expect(w.read("another-tool")).toEqual({ refused: 0, unreadable: 1, ran: [] });
});

test("a kind of record this build does not know, or one too large to read, is not taken as no call", () => {
	const w = world();
	w.turn("t1", "desk", at(1), [["brand_new_tool", "completed", {}]]);
	expect(w.read("t1")).toEqual({ refused: 0, unreadable: 1, ran: [] });
	w.turn("t2", "desk", at(1), [
		["command_execution", "completed", { input: "uptime", output: "x".repeat(200_000) }],
		["assistant_message", "completed", { text: "x".repeat(200_000) }],
	]);
	expect(w.read("t2")).toEqual({ refused: 0, unreadable: 1, ran: [] });
	w.turn(
		"t3",
		"desk",
		at(1),
		Array.from({ length: 401 }, (): Item => ["reasoning", "completed", {}]),
	);
	expect(w.read("t3")).toEqual({ refused: 0, unreadable: 1, ran: [] });
});

test("the desk's and its gatherers' finished turns, in order, in the span, with their record counts", () => {
	const w = world();
	w.turn("b", "desk", at(2));
	w.turn("a", "child", at(2), [["reasoning", "completed", {}]]);
	w.turn("0c", "desk", at(4));
	w.turn("late", "desk", at(8));
	w.turn("running", "desk", null);
	w.turn("x", "stranger", at(3));
	const ids = (o: object = {}) => w.turns.list(span(o))?.map((t) => t.id);
	expect(ids()).toEqual(["a", "b", "0c", "late"]);
	expect(ids({ until: at(4) })).toEqual(["a", "b", "0c"]);
	expect(ids({ limit: 2 })).toEqual(["a", "b"]);
	expect(ids({ after: at(2) })).toEqual(["0c", "late"]);
	expect(w.turns.list(span())?.[0]).toEqual({ id: "a", at: at(2), items: 1, rev: "1 t0" });
	expect(w.turns.list(span())?.[1]).toEqual({ id: "b", at: at(2), items: 0, rev: "0 " });
	w.db.run("update orchestration_v2_projection_turn_items set updated_at = 't1' where provider_turn_id = 'a'");
	expect(w.turns.list(span())?.[0]?.rev).toBe("1 t1");
	w.items("a", [["reasoning", "completed", {}]]);
	expect(w.turns.list(span())?.[0]?.items).toBe(2);
	expect(deskTurns(w.path, () => undefined).list(span())).toBeUndefined();
	expect(deskTurns("/nowhere", () => "desk").list(span())).toBeUndefined();
	expect(deskTurns("/nowhere", () => "desk").read({ id: "a", at: "", items: 0, rev: "" })).toBeUndefined();
	expect(deskTurns("/nowhere", () => "desk").env()).toEqual({});
});

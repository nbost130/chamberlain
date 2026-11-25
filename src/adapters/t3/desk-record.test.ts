import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deskEnforced, deskTurns } from "./desk-record.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REFUSAL = "Error: PreToolUse:Bash hook error: [hook]: alert desk allowlist: refused. not on the list";
type Item = [type: string, status: string, payload: object | string];

function world(driver = "claudeAgent", over: { instance?: string | null; worktree?: string } = {}) {
	const dir = mkdtempSync(`${tmpdir()}/desk-record-`);
	dirs.push(dir);
	const path = `${dir}/state.sqlite`;
	const db = new Database(path);
	const p = "orchestration_v2_projection";
	db.run(`create table ${p}_threads (thread_id text, payload_json text)`);
	db.run("create table projection_projects (project_id text, workspace_root text)");
	db.run(`create table ${p}_provider_threads (driver text, provider_instance_id text)`);
	db.run(`create table ${p}_provider_turns (provider_turn_id text, thread_id text, status text, completed_at text)`);
	db.run(`create table ${p}_subagents (thread_id text, child_thread_id text)`);
	db.run(`create table ${p}_turn_items (provider_turn_id text, type text, status text, payload_json text)`);
	const instance = over.instance === undefined ? "main" : over.instance;
	db.run(`insert into ${p}_threads values ('desk', ?)`, [
		JSON.stringify({ modelSelection: { instanceId: instance }, projectId: "pr", worktreePath: over.worktree ?? null }),
	]);
	db.run("insert into projection_projects values ('pr', '/desk')");
	db.run(`insert into ${p}_provider_threads values (?, 'main')`, [driver]);
	db.run(`insert into ${p}_subagents values ('desk', 'child'), ('other', 'stranger'), ('desk', null)`);
	const turn = (id: string, thread: string, at: string | null, items: Item[] = []) => {
		db.run(`insert into ${p}_provider_turns values (?, ?, ?, ?)`, [id, thread, at ? "completed" : "running", at]);
		db.transaction(() => {
			for (const [type, status, payload] of items)
				db.run(`insert into ${p}_turn_items values (?, ?, ?, ?)`, [
					id,
					type,
					status,
					typeof payload === "string" ? payload : JSON.stringify(payload),
				]);
		})();
	};
	return { path, db, turn };
}
const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
const span = (o: object = {}) => ({ after: { at: at(0), id: "" }, until: at(9), limit: 50, ...o });

test("a desk is enforced only on a driver that runs the hook, in a project that has it", () => {
	const seen: string[] = [];
	const hook = (root: string) => {
		seen.push(root);
		return { DESK_LOG_DIRS: "/x" };
	};
	expect(deskEnforced(world().path, "desk", hook)).toEqual({ DESK_LOG_DIRS: "/x" });
	expect(deskEnforced(world("claudeAgent", { worktree: "/tree" }).path, "desk", hook)).toBeDefined();
	expect(seen).toEqual(["/desk", "/tree"]);
	expect(deskEnforced(world().path, "desk", () => undefined)).toBeUndefined();
	for (const driver of ["cursor", "codex", "antigravity", "grok", "anything-new"])
		expect(deskEnforced(world(driver).path, "desk", hook), driver).toBeUndefined();
});

test("whatever cannot be read, or does not name one driver, is not enforced", () => {
	const hook = () => ({});
	expect(deskEnforced(world().path, undefined, hook)).toBeUndefined();
	expect(deskEnforced(world().path, "gone", hook)).toBeUndefined();
	expect(deskEnforced(world("claudeAgent", { instance: null }).path, "desk", hook)).toBeUndefined();
	expect(deskEnforced(world("claudeAgent", { instance: "never-used" }).path, "desk", hook)).toBeUndefined();
	const two = world();
	two.db.run("insert into orchestration_v2_projection_provider_threads values ('cursor', 'main')");
	expect(deskEnforced(two.path, "desk", hook)).toBeUndefined();
	const rootless = world();
	rootless.db.run("delete from projection_projects");
	expect(deskEnforced(rootless.path, "desk", hook)).toBeUndefined();
	expect(deskEnforced("/nowhere/state.sqlite", "desk", hook)).toBeUndefined();
	const changed = world();
	changed.db.run("drop table orchestration_v2_projection_provider_threads");
	expect(deskEnforced(changed.path, "desk", hook)).toBeUndefined();
});

test("a turn's records become what ran, what the hook refused and what cannot be replayed", () => {
	const w = world();
	w.turn("t1", "desk", at(1), [
		["command_execution", "completed", { input: "uptime" }],
		["command_execution", "failed", { input: "false", output: "Error: Exit code 1" }],
		["command_execution", "failed", { input: "rm x", output: REFUSAL }],
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
		["assistant_message", "completed", { text: "hi" }],
	]);
	expect(deskTurns(w.path, "desk", span())?.turns).toEqual([
		{
			id: "t1",
			at: at(1),
			items: 18,
			refused: 1,
			unreadable: 7,
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
		},
	]);
});

test("the desk's and its gatherers' finished turns, in order, after the cursor and up to the limit", () => {
	const w = world();
	w.turn("b", "desk", at(2));
	w.turn("a", "child", at(2));
	w.turn("0c", "desk", at(4));
	w.turn("late", "desk", at(8));
	w.turn("running", "desk", null);
	w.turn("x", "stranger", at(3));
	const ids = (o: object = {}) => deskTurns(w.path, "desk", span(o))?.turns.map((t) => t.id);
	expect(ids()).toEqual(["a", "b", "0c", "late"]);
	expect(ids({ until: at(4) })).toEqual(["a", "b", "0c"]);
	expect(ids({ limit: 2 })).toEqual(["a", "b"]);
	expect(ids({ after: { at: at(2), id: "a" } })).toEqual(["b", "0c", "late"]);
	expect(deskTurns(w.path, undefined, span())).toBeUndefined();
	expect(deskTurns(w.path, "gone", span())).toBeUndefined();
	expect(deskTurns("/nowhere", "desk", span())).toBeUndefined();
});

test("a turn with more records than are read says so", () => {
	const w = world();
	w.turn(
		"big",
		"desk",
		at(1),
		Array.from({ length: 2_001 }, (): Item => ["reasoning", "completed", {}]),
	);
	expect(deskTurns(w.path, "desk", span())?.turns[0]).toMatchObject({ items: 2_001, unreadable: 1, ran: [] });
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveSteward, t3Transcript, threadReadKey } from "./transcript.ts";

const session = "11111111-2222-3333-4444-555555555555";

test("identity follows the active provider thread, not newest transcript", () => {
	const dir = mkdtempSync(`${tmpdir()}/health-db-`),
		path = `${dir}/state.sqlite`;
	const db = new Database(path);
	try {
		writeFileSync(`${dir}/steward-thread`, "steward", { mode: 0o600 });
		db.exec(
			"create table orchestration_v2_projection_threads(thread_id text, active_provider_thread_id text); create table orchestration_v2_projection_provider_threads(provider_thread_id text, provider_session_id text, payload_json text); create table orchestration_v2_projection_provider_sessions(provider_session_id text, payload_json text)",
		);
		db.query("insert into orchestration_v2_projection_threads values (?,?)").run("steward", "active");
		db.query("insert into orchestration_v2_projection_provider_threads values (?,?,?)").run(
			"active",
			"provider",
			JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId: session } }),
		);
		db.query("insert into orchestration_v2_projection_provider_sessions values (?,?)").run(
			"provider",
			JSON.stringify({ cwd: "/home/test/Projects/chamberlain" }),
		);
		expect(resolveSteward(path, dir)).toEqual({
			thread: "steward",
			session,
			project: "-home-test-Projects-chamberlain",
		});
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the transcript is the Claude Code file for that session under the Steward's project folder", async () => {
	const dir = mkdtempSync(`${tmpdir()}/health-db-`),
		path = `${dir}/state.sqlite`;
	const db = new Database(path);
	try {
		writeFileSync(`${dir}/steward-thread`, "steward", { mode: 0o600 });
		db.exec(
			"create table orchestration_v2_projection_threads(thread_id text, active_provider_thread_id text); create table orchestration_v2_projection_provider_threads(provider_thread_id text, provider_session_id text, payload_json text); create table orchestration_v2_projection_provider_sessions(provider_session_id text, payload_json text)",
		);
		db.query("insert into orchestration_v2_projection_threads values (?,?)").run("steward", "active");
		db.query("insert into orchestration_v2_projection_provider_threads values (?,?,?)").run(
			"active",
			"provider",
			JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId: session } }),
		);
		db.query("insert into orchestration_v2_projection_provider_sessions values (?,?)").run(
			"provider",
			JSON.stringify({ cwd: "/home/test/Projects/chamberlain" }),
		);
		expect(await t3Transcript({ dbPath: path, conf: dir, claudeDir: "/claude" })).toMatchObject({
			path: `/claude/projects/-home-test-Projects-chamberlain/${session}.jsonl`,
			session,
			thread: "steward",
		});
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the Steward's thread reads are its t3_thread_read calls and its peek.ts runs, by the thread they read", () => {
	expect(threadReadKey("mcp__t3-code__t3_thread_read", { threadId: "t1", environmentId: "env" })).toBe("env:t1");
	expect(threadReadKey("mcp__t3-code__t3_thread_read", { threadId: "t1" })).toBe("local:t1");
	expect(threadReadKey("Bash", { command: "bun src/adapters/t3/peek.ts main thread-9 5" })).toBe("main:thread-9");
	expect(threadReadKey("Bash", { command: "ls" })).toBeUndefined();
	expect(threadReadKey("Read", { file_path: "/x" })).toBeUndefined();
});

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunningRunIdsFromStateDb, parkedSinceFromStateDb } from "./prepare-pr-nm-state.ts";

function tempStateDb(rows: { path: string; upstream: string; runId: string; status: string }[]): string {
	const dir = mkdtempSync(join(tmpdir(), "nm-state-"));
	const path = join(dir, "state.sqlite");
	const db = new Database(path);
	db.exec(`
		CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL UNIQUE, upstream_url TEXT NOT NULL, fork_url TEXT, default_branch TEXT NOT NULL DEFAULT 'main', created_at INTEGER NOT NULL);
		CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, status TEXT NOT NULL, awaiting_agent_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
	`);
	let i = 0;
	for (const r of rows) {
		const repoId = `repo-${++i}`;
		db.run(`INSERT INTO repos (id, working_path, upstream_url, created_at) VALUES (?, ?, ?, 1)`, [
			repoId,
			r.path,
			r.upstream,
		]);
		db.run(
			`INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, awaiting_agent_since, created_at, updated_at) VALUES (?, ?, 'b', 'h', 'b', ?, 100, 1, ?)`,
			[r.runId, repoId, r.status, i],
		);
	}
	db.close();
	return path;
}

describe("listRunningRunIdsFromStateDb", () => {
	test("discovers all checkouts sharing upstream_url", () => {
		const dbPath = tempStateDb([
			{ path: "/cfg/MemberHero", upstream: "git@github.com:org/memberhero.git", runId: "MAIN", status: "running" },
			{
				path: "/tmp/agent-tmp/x",
				upstream: "git@github.com:org/memberhero.git",
				runId: "TEMP",
				status: "running",
			},
			{ path: "/other", upstream: "git@github.com:org/other.git", runId: "OTHER", status: "running" },
		]);
		expect(listRunningRunIdsFromStateDb(dbPath, "/cfg/MemberHero").sort()).toEqual(["MAIN", "TEMP"]);
	});
	test("unknown working_path fails closed", () => {
		const dbPath = tempStateDb([
			{ path: "/cfg/MemberHero", upstream: "git@github.com:org/memberhero.git", runId: "MAIN", status: "running" },
		]);
		expect(() => listRunningRunIdsFromStateDb(dbPath, "/missing")).toThrow(/no repo for working_path/);
	});
	test("missing db fails closed", () => {
		expect(() => listRunningRunIdsFromStateDb("/no/such/state.sqlite", "/x")).toThrow(/unreadable/);
	});
});

describe("parkedSinceFromStateDb", () => {
	test("reads awaiting_agent_since as epoch ms", () => {
		const dbPath = tempStateDb([
			{ path: "/cfg/MemberHero", upstream: "git@github.com:org/memberhero.git", runId: "MAIN", status: "running" },
		]);
		expect(parkedSinceFromStateDb(dbPath, ["MAIN"]).get("MAIN")).toBe(100_000);
	});
});

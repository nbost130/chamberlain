#!/usr/bin/env bun
// Git hook helpers. lefthook.yml calls these; nothing here is needed to build or run Chamberlain.
//
//   install       lefthook install (skipped in CI and outside a git checkout)
//   guard         refuse an environment that drops hook jobs (LEFTHOOK_EXCLUDE, LEFTHOOK_ONLY)
//   mark          pre-commit, last job: record the staged tree as verified
//   audit         post-commit: log a commit whose tree no pre-commit run verified (git commit --no-verify)
//   changed-lint  pre-push: Biome on every file changed against origin/main
//   lock <cmd>    run <cmd> while holding the one heavy-work lock all worktrees of this clone share
//
// `git commit --no-verify` skips pre-commit but not post-commit, so `audit` sees it and writes a line to
// <git-common-dir>/chamberlain-hooks/bypass.log. Git has no hook after a `git push --no-verify`, and
// LEFTHOOK=0 or excluding every job stops lefthook before any code of ours runs; CI runs the same
// checks on every PR and is what catches those.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DROPPING_VARS = ["LEFTHOOK_EXCLUDE", "LEFTHOOK_ONLY"];
const LOCK_TIMEOUT_MS = 600_000;
const MAX_VERIFIED = 500;
/** Reflog actions whose commits git makes without running pre-commit: not a bypass. */
const REPLAY_ACTIONS = ["cherry-pick", "revert", "rebase", "merge", "pull", "am"];

function git(args: string[]): { ok: boolean; out: string } {
	const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
}

function stateDir(): string {
	const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!common.ok) throw new Error("not a git repository");
	const dir = join(common.out, "chamberlain-hooks");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The environment variables that make lefthook skip jobs, one message each. */
export function droppedJobs(env: Record<string, string | undefined>): string[] {
	return DROPPING_VARS.filter((name) => (env[name] ?? "").trim() !== "").map(
		(name) => `${name}=${env[name]} drops hook jobs. The hooks are not skippable; fix what they report.`,
	);
}

/** Whether a commit that no pre-commit run verified should be logged as a bypass. */
export function isBypass(commit: { parents: number; action: string; tree: string }, verified: string[]): boolean {
	if (commit.parents > 1) return false;
	if (REPLAY_ACTIONS.some((action) => commit.action.startsWith(action))) return false;
	return !verified.includes(commit.tree);
}

function readLines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function guard(): number {
	const problems = droppedJobs(process.env);
	for (const problem of problems) console.error(`hooks: ${problem}`);
	return problems.length > 0 ? 1 : 0;
}

function mark(): number {
	if (guard() !== 0) return 1;
	const tree = git(["write-tree"]);
	if (!tree.ok) return 1;
	const file = join(stateDir(), "verified-trees");
	const kept = [...readLines(file), tree.out].slice(-MAX_VERIFIED);
	writeFileSync(file, `${kept.join("\n")}\n`);
	return 0;
}

function audit(): number {
	const tree = git(["rev-parse", "HEAD^{tree}"]);
	const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]);
	if (!tree.ok || !parents.ok) return 0;
	const commit = {
		parents: parents.out.split(" ").length - 1,
		action: process.env.GIT_REFLOG_ACTION ?? "",
		tree: tree.out,
	};
	const dir = stateDir();
	if (!isBypass(commit, readLines(join(dir, "verified-trees")))) return 0;
	const sha = git(["rev-parse", "HEAD"]).out;
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
	appendFileSync(join(dir, "bypass.log"), `${JSON.stringify({ at: new Date().toISOString(), sha, branch })}\n`);
	console.error(
		`hooks: commit ${sha.slice(0, 9)} skipped the pre-commit checks; logged to ${join(dir, "bypass.log")}.`,
	);
	console.error("hooks: CI runs the same checks and will fail it if it breaks one.");
	return 0;
}

function changedFiles(): string[] | undefined {
	const base = git(["merge-base", "origin/main", "HEAD"]);
	if (!base.ok) return undefined;
	const diff = git(["diff", "--name-only", "--diff-filter=ACMR", `${base.out}...HEAD`]);
	return diff.ok ? diff.out.split("\n").filter((file) => /^(src|scripts)\/.*\.ts$/.test(file)) : undefined;
}

async function run(cmd: string[]): Promise<number> {
	return await Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exited;
}

async function changedLint(): Promise<number> {
	const files = changedFiles();
	if (files === undefined) {
		console.error("hooks: origin/main is not fetched here; running Biome on the whole repo instead.");
		return await run(["bunx", "biome", "check", "--error-on-warnings", "."]);
	}
	if (files.length === 0) return 0;
	return await run(["bunx", "biome", "check", "--error-on-warnings", "--no-errors-on-unmatched", ...files]);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Take the lock by creating its directory; clear it when its owner is gone. */
function takeLock(dir: string): boolean {
	try {
		mkdirSync(dir);
	} catch {
		const owner = Number(readLines(join(dir, "pid"))[0]);
		if (!owner || !alive(owner)) rmSync(dir, { recursive: true, force: true });
		return false;
	}
	writeFileSync(join(dir, "pid"), String(process.pid));
	return true;
}

async function withLock(cmd: string[]): Promise<number> {
	const dir = join(stateDir(), "heavy.lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (!takeLock(dir)) {
		if (Date.now() > deadline) {
			console.error(`hooks: timed out waiting for ${dir}. Another worktree is running the checks; wait for it.`);
			return 1;
		}
		await Bun.sleep(1000);
	}
	const release = () => rmSync(dir, { recursive: true, force: true });
	process.on("SIGINT", () => {
		release();
		process.exit(130);
	});
	try {
		return await run(cmd);
	} finally {
		release();
	}
}

async function install(): Promise<number> {
	if (process.env.CI) return 0;
	if (!git(["rev-parse", "--git-dir"]).ok) return 0;
	return await run(["bunx", "lefthook", "install"]);
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	const commands: Record<string, () => number | Promise<number>> = {
		install,
		guard,
		mark,
		audit,
		"changed-lint": changedLint,
		lock: () => withLock(rest),
	};
	const handler = commands[command ?? ""];
	if (!handler) {
		console.error(`usage: bun scripts/hooks.ts <${Object.keys(commands).join("|")}>`);
		process.exit(2);
	}
	process.exit(await handler());
}

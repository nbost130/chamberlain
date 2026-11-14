#!/usr/bin/env bun
// Git hook helpers. lefthook.yml calls these; nothing here is needed to build or run Chamberlain.
//
//   install     lefthook install (skipped in CI and outside a git checkout)
//   pre-commit  refuse an environment that drops hook jobs (LEFTHOOK_EXCLUDE, LEFTHOOK_ONLY); Biome on the staged files;
//               the typecheck; then record the staged tree as verified
//   audit       post-commit: log a commit whose tree no pre-commit run verified (git commit --no-verify)
//   pre-push    the same refusal; the typecheck; Biome on every file changed against origin/main; knip; jscpd; then the full
//               tests, under the one heavy-work lock all worktrees of this clone share
//
// Each hook is one lefthook job that runs its steps here in order and stops at the first failure, so a failed check never
// reaches the step that marks a tree verified, and never starts the 100-second test run.
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

const LINTED = /^(src|scripts)\/.*\.ts$/;
const BIOME = ["bunx", "biome", "check", "--error-on-warnings", "--no-errors-on-unmatched"];

/** The linted files a git command lists, or undefined when the command fails. */
function listed(args: string[]): string[] | undefined {
	const out = git(args);
	return out.ok ? out.out.split("\n").filter((file) => LINTED.test(file)) : undefined;
}

function changedFiles(): string[] | undefined {
	const base = git(["merge-base", "origin/main", "HEAD"]);
	return base.ok ? listed(["diff", "--name-only", "--diff-filter=ACMR", `${base.out}...HEAD`]) : undefined;
}

async function run(cmd: string[]): Promise<number> {
	return await Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exited;
}

/** Biome on `files` (every file when undefined); nothing to check is a pass. */
async function lint(files: string[] | undefined): Promise<number> {
	if (files === undefined) return await run([...BIOME, "."]);
	return files.length === 0 ? 0 : await run([...BIOME, ...files]);
}

type Step = [name: string, run: () => number | Promise<number>];

/** Runs the steps in order and stops at the first one that fails. */
async function sequence(steps: Step[]): Promise<number> {
	for (const [name, step] of steps) {
		const code = await step();
		if (code !== 0) {
			console.error(`hooks: ${name} failed`);
			return code;
		}
	}
	return 0;
}

const preCommit = () =>
	sequence([
		["guard", guard],
		["biome on the staged files", () => lint(listed(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]))],
		["typecheck", () => run(["bun", "run", "typecheck"])],
		["mark", mark],
	]);

function changedLint(): Promise<number> {
	const files = changedFiles();
	if (files === undefined)
		console.error("hooks: origin/main is not fetched here; running Biome on the whole repo instead.");
	return lint(files);
}

const prePush = () =>
	sequence([
		["guard", guard],
		["typecheck", () => run(["bun", "run", "typecheck"])],
		["biome on the changed files", changedLint],
		["knip", () => run(["bun", "run", "knip"])],
		["jscpd", () => run(["bun", "run", "jscpd"])],
		["tests", () => withLock(["bun", "test"])],
	]);

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
	const [command] = process.argv.slice(2);
	const commands: Record<string, () => number | Promise<number>> = {
		install,
		"pre-commit": preCommit,
		audit,
		"pre-push": prePush,
	};
	const handler = commands[command ?? ""];
	if (!handler) {
		console.error(`usage: bun scripts/hooks.ts <${Object.keys(commands).join("|")}>`);
		process.exit(2);
	}
	process.exit(await handler());
}

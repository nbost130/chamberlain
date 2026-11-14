#!/usr/bin/env bun
// Git hook helpers. lefthook.yml calls these; nothing here is needed to build or run Chamberlain.
//
//   install     lefthook install (skipped in CI and outside a git checkout)
//   pre-commit  refuse an environment that drops hook jobs (LEFTHOOK_EXCLUDE, LEFTHOOK_ONLY); on a snapshot of the INDEX
//               (what the commit will contain, not the working tree): Biome on the staged files and the typecheck; then
//               record the staged tree as verified
//   audit       post-commit: log a commit whose tree no pre-commit run verified (git commit --no-verify)
//   pre-push    the same refusal; then, for each commit being pushed (git hands them on stdin, so a push of another branch
//               or a dirty working tree is not what gets checked), on a snapshot of that commit: the typecheck, Biome on
//               the files it changes against origin/main, knip, jscpd, and the full tests under the one heavy-work lock
//               all worktrees of this clone share
//
// Each hook is one lefthook job that runs its steps here in order and stops at the first failure, so a failed check never
// reaches the step that marks a tree verified, and never starts the 100-second test run.
//
// `git commit --no-verify` skips pre-commit but not post-commit, so `audit` sees it and writes a line to
// <git-common-dir>/chamberlain-hooks/bypass.log. Git has no hook after a `git push --no-verify`, and
// LEFTHOOK=0 or excluding every job stops lefthook before any code of ours runs; CI runs the same
// checks on every PR and is what catches those.

import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DROPPING_VARS = ["LEFTHOOK_EXCLUDE", "LEFTHOOK_ONLY"];
const LOCK_TIMEOUT_MS = 600_000;
const MAX_VERIFIED = 500;
const NO_SHA = /^0+$/;
/** Reflog actions whose commits git makes without running pre-commit: not a bypass. */
const REPLAY_ACTIONS = ["cherry-pick", "revert", "rebase", "merge", "pull", "am"];

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
	const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
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

// ---- snapshots: the checks run on the bytes that will be committed or pushed ----------------------------------------

/** Writes every file of the index (what the next commit will contain) under `dir`. */
export function snapshotIndex(root: string, dir: string): boolean {
	return git(["checkout-index", "--all", `--prefix=${dir}/`], root).ok;
}

/** Writes the tree of commit `sha` under `dir`. */
export function snapshotCommit(root: string, sha: string, dir: string): boolean {
	const archive = Bun.spawnSync(["git", "archive", "--format=tar", sha], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (archive.exitCode !== 0) return false;
	return Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout }).exitCode === 0;
}

/** Fills a fresh temporary directory, links the clone's node_modules into it, runs `body` there, and removes it. */
async function inSnapshot(root: string, fill: (dir: string) => boolean, body: (dir: string) => Promise<number>) {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-hook-"));
	try {
		if (!fill(dir)) {
			console.error("hooks: could not take a snapshot to check");
			return 1;
		}
		symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
		return await body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const LINTED = /^(src|scripts)\/.*\.ts$/;
/** The snapshot has no .git, so Biome must not look for one. */
const BIOME = ["bunx", "biome", "check", "--error-on-warnings", "--no-errors-on-unmatched", "--vcs-enabled=false"];

/** The linted files a git command lists, or undefined when the command fails. */
function listed(args: string[], root: string): string[] | undefined {
	const out = git(args, root);
	return out.ok ? out.out.split("\n").filter((file) => LINTED.test(file)) : undefined;
}

async function run(cmd: string[], cwd: string): Promise<number> {
	return await Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
}

/** Biome on `files` (every file when undefined); nothing to check is a pass. */
async function lint(files: string[] | undefined, dir: string): Promise<number> {
	if (files === undefined) return await run([...BIOME, "."], dir);
	return files.length === 0 ? 0 : await run([...BIOME, ...files], dir);
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

function repoRoot(): string {
	const top = git(["rev-parse", "--show-toplevel"]);
	if (!top.ok) throw new Error("not a git repository");
	return top.out;
}

const preCommit = () => {
	const root = repoRoot();
	const staged = listed(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], root);
	return sequence([
		["guard", guard],
		[
			"checks on the staged files",
			() =>
				inSnapshot(
					root,
					(dir) => snapshotIndex(root, dir),
					(dir) =>
						sequence([
							["biome", () => lint(staged, dir)],
							["typecheck", () => run(["bun", "run", "typecheck"], dir)],
						]),
				),
		],
		["mark", mark],
	]);
};

// ---- pre-push ---------------------------------------------------------------------------------------------------------

/** The distinct commits git says it is pushing: the local sha of each `<ref> <sha> <remote ref> <remote sha>` line, deletions left out. */
export function pushedShas(stdin: string): string[] {
	const shas = stdin
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[1])
		.filter((sha): sha is string => sha !== undefined && sha !== "" && !NO_SHA.test(sha));
	return [...new Set(shas)];
}

/** The linted files commit `sha` changes against origin/main, or undefined when origin/main is not known here. */
function changedBy(root: string, sha: string): string[] | undefined {
	const base = git(["merge-base", "origin/main", sha], root);
	if (!base.ok) {
		console.error("hooks: origin/main is not fetched here; running Biome on the whole repo instead.");
		return undefined;
	}
	return listed(["diff", "--name-only", "--diff-filter=ACMR", `${base.out}...${sha}`], root);
}

const checksOf = (root: string, sha: string): Promise<number> =>
	inSnapshot(
		root,
		(dir) => snapshotCommit(root, sha, dir),
		(dir) =>
			sequence([
				["typecheck", () => run(["bun", "run", "typecheck"], dir)],
				["biome on the changed files", () => lint(changedBy(root, sha), dir)],
				["knip", () => run(["bun", "run", "knip"], dir)],
				["jscpd", () => run(["bun", "run", "jscpd"], dir)],
				["tests", () => withLock(["bun", "test"], dir)],
			]),
	);

async function prePush(): Promise<number> {
	const guarded = await sequence([["guard", guard]]);
	if (guarded !== 0) return guarded;
	const root = repoRoot();
	const stdin = await Bun.stdin.text();
	const pushed = stdin.trim() === "" ? [git(["rev-parse", "HEAD"], root).out] : pushedShas(stdin);
	for (const sha of pushed) {
		const code = await sequence([[`checks on ${sha.slice(0, 9)}`, () => checksOf(root, sha)]]);
		if (code !== 0) return code;
	}
	return 0;
}

// ---- the heavy-work lock ------------------------------------------------------------------------------------------------

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ownerOf(path: string): number {
	return Number(readLines(path)[0]) || 0;
}

/**
 * Takes the lock: a file holding our pid, put in place with link(2), which fails if it exists and leaves no moment when
 * the file exists empty. A lock whose owner is gone is moved aside (rename is atomic, so one waiter wins it) and the
 * attempt is made again by the caller's loop.
 */
export function takeLock(path: string): boolean {
	const mine = `${path}.${process.pid}.${Date.now()}`;
	writeFileSync(mine, String(process.pid));
	try {
		linkSync(mine, path);
		return true;
	} catch {
		reclaimIfDead(path);
		return false;
	} finally {
		rmSync(mine, { force: true });
	}
}

function reclaimIfDead(path: string): void {
	const owner = ownerOf(path);
	if (owner && alive(owner)) return;
	const aside = `${path}.stale.${process.pid}.${Date.now()}`;
	try {
		renameSync(path, aside);
	} catch {
		return; // another waiter moved it first
	}
	// If a live lock was swapped in between our read and the rename, put it back.
	if (ownerOf(aside) !== owner) {
		try {
			linkSync(aside, path);
		} catch {
			// a newer lock is already in place: nothing to restore
		}
	}
	rmSync(aside, { force: true });
}

/** Removes the lock only when it is ours. */
export function releaseLock(path: string): void {
	if (ownerOf(path) === process.pid) rmSync(path, { force: true });
}

async function withLock(cmd: string[], cwd: string): Promise<number> {
	const path = join(stateDir(), "heavy.lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (!takeLock(path)) {
		if (Date.now() > deadline) {
			console.error(`hooks: timed out waiting for ${path}. Another worktree is running the checks; wait for it.`);
			return 1;
		}
		await Bun.sleep(1000);
	}
	process.on("SIGINT", () => {
		releaseLock(path);
		process.exit(130);
	});
	try {
		return await run(cmd, cwd);
	} finally {
		releaseLock(path);
	}
}

async function install(): Promise<number> {
	if (process.env.CI) return 0;
	if (!git(["rev-parse", "--git-dir"]).ok) return 0;
	return await run(["bunx", "lefthook", "install"], process.cwd());
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

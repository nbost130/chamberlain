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
// Every check and the test run is started with an explicit environment that has no GIT_* variable (scripts/git-env.ts): git exports
// GIT_DIR and others to a hook, and a child that inherits them points the git commands of a test at the real repository. The test run
// also gets a scratch HOME and global git config under TMPDIR and no system config.
//
// Each hook is one lefthook job that runs its steps here in order and stops at the first failure, so a failed check never
// reaches the step that marks a tree verified, and never starts the 100-second test run.
//
// `git commit --no-verify` skips pre-commit but not post-commit, so `audit` sees it and writes a line to
// <git-common-dir>/chamberlain-hooks/bypass.log. Git has no hook after a `git push --no-verify`, and
// LEFTHOOK=0 or excluding every job stops lefthook before any code of ours runs; CI runs the same
// checks on every PR and is what catches those.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./hooks-lock.ts";
import { inSnapshot, run, runTests, snapshotCommit, snapshotIndex } from "./hooks-run.ts";

const DROPPING_VARS = ["LEFTHOOK_EXCLUDE", "LEFTHOOK_ONLY"];
export const LOCK_TIMEOUT_MS = 600_000;
const MAX_VERIFIED = 500;
const NO_SHA = /^0+$/;
/** Reflog actions whose commits git makes without running pre-commit: not a bypass. */
const REPLAY_ACTIONS = ["cherry-pick", "revert", "rebase", "merge", "pull", "am"];

/**
 * Runs git. The hook's own git calls keep the environment git gave the hook (GIT_DIR, GIT_INDEX_FILE: they name the repository
 * being pushed or committed to); a caller that works on some other repository, as the tests do, passes a sealed `env`.
 */
export function git(
	args: string[],
	cwd?: string,
	env: Record<string, string | undefined> = process.env,
): { ok: boolean; out: string } {
	const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", env, ...(cwd ? { cwd } : {}) });
	return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
}

export function stateDir(): string {
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

export function readLines(file: string): string[] {
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

const LINTED = /^(src|scripts)\/.*\.ts$/;
/** The snapshot has no .git, so Biome must not look for one. */
const BIOME = ["bunx", "biome", "check", "--error-on-warnings", "--no-errors-on-unmatched", "--vcs-enabled=false"];

/** The linted files a git command lists, or undefined when the command fails. */
function listed(args: string[], root: string): string[] | undefined {
	const out = git(args, root);
	return out.ok ? out.out.split("\n").filter((file) => LINTED.test(file)) : undefined;
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
				["tests", () => withLock(() => runTests(["bun", "test"], dir))],
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

async function install(): Promise<number> {
	if (process.env.CI) return 0;
	if (!git(["rev-parse", "--git-dir"]).ok) return 0;
	return await run(["bunx", "lefthook", "install"], process.cwd(), process.env);
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

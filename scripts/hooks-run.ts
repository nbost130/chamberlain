/** Running a hook step: the sealed-environment command runner, the test run, and the snapshots a step is run on. */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchGitHome, sealedGitEnv, testRunEnv } from "./git-env.ts";
import { git } from "./hooks-base.ts";

/** Writes every file of the index (what the next commit will contain) under `dir`. */
export function snapshotIndex(
	root: string,
	dir: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return git(["checkout-index", "--all", `--prefix=${dir}/`], root, env).ok;
}

/** Writes the tree of commit `sha` under `dir`. */
export function snapshotCommit(
	root: string,
	sha: string,
	dir: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const archive = Bun.spawnSync(["git", "archive", "--format=tar", sha], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (archive.exitCode !== 0) return false;
	return Bun.spawnSync(["tar", "-x", "-C", dir], { env: sealedGitEnv(env), stdin: archive.stdout }).exitCode === 0;
}

/** Fills a fresh temporary directory, links the clone's node_modules into it, runs `body` there, and removes it. */
export async function inSnapshot(root: string, fill: (dir: string) => boolean, body: (dir: string) => Promise<number>) {
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

/**
 * Starts one check or test run and waits for it. The child gets an explicit environment with every GIT_* variable removed
 * (scripts/git-env.ts): git exports GIT_DIR and others to a hook, and a child that inherits them points every git command it
 * runs, a test's `git init` and `git config` included, at the real repository. No shell is involved, so nothing re-reads them.
 */
export async function run(
	cmd: string[],
	cwd: string,
	env: Record<string, string | undefined> = sealedGitEnv(process.env),
): Promise<number> {
	return await Bun.spawn(cmd, { cwd, env, stdio: ["inherit", "inherit", "inherit"] }).exited;
}

/**
 * The test run: `cmd` in `cwd` with the sealed environment of every other step, plus a scratch HOME and global git config under
 * TMPDIR and no system config, so a test that runs git can neither read nor write the developer's real git configuration.
 * `base` is the environment to seal (the hook's own, unless a test of this function says otherwise).
 */
export async function runTests(
	cmd: string[],
	cwd: string,
	base: Record<string, string | undefined> = process.env,
): Promise<number> {
	const scratch = scratchGitHome();
	const remove = () => rmSync(scratch.root, { recursive: true, force: true });
	// process.exit() (the lock's ^C handler) does not unwind this function, but it does run 'exit' listeners.
	process.on("exit", remove);
	try {
		return await run(cmd, cwd, testRunEnv(base, scratch));
	} finally {
		process.off("exit", remove);
		remove();
	}
}

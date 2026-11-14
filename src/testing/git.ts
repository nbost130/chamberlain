/**
 * The one way a test runs git. It always names the repository (`git -C <dir>` and the same cwd), refuses a directory that is not under
 * this run's TMPDIR, and starts git with an explicit environment: every GIT_* variable removed (so a hook's GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, GIT_COMMON_DIR or GIT_CONFIG* cannot point git at the real repository), no system config, and no global config. The
 * identity and branch name come from `-c` flags, which write nothing. A test that runs git any other way can corrupt the clone that
 * launched the run (2026-11-14: core.bare, user.name and a commit "one" in the shared clone's config and branch).
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { GIT_TEST_IDENTITY, sealedGitEnv } from "../../scripts/git-env.ts";

/** The environment every test git command runs in. */
export function gitTestEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
	return { ...sealedGitEnv(base), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

const underTmp = (dir: string): boolean => {
	const rel = relative(realpathSync(tmpdir()), realpathSync(resolve(dir)));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export type GitResult = { ok: boolean; out: string; err: string };

/** Runs `git <args>` in the temp repository `repo` (an absolute path under TMPDIR) and returns the outcome; it never throws on a git failure. */
export function tryGit(repo: string, ...args: string[]): GitResult {
	if (!isAbsolute(repo) || !underTmp(repo))
		throw new Error(`test git runs only in a temp directory under TMPDIR (${tmpdir()}), not ${repo}`);
	const p = Bun.spawnSync(["git", "-C", repo, ...GIT_TEST_IDENTITY.flatMap((c) => ["-c", c]), ...args], {
		cwd: repo,
		env: gitTestEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/** `tryGit`, but a failing command throws with git's message. Returns git's trimmed stdout. */
export function git(repo: string, ...args: string[]): string {
	const r = tryGit(repo, ...args);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed in ${repo}: ${r.err}`);
	return r.out;
}

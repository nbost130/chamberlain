// The environment a process gets when it must not reach the clone that launched it.
//
// Git runs a hook with GIT_DIR (and, from a linked worktree, GIT_INDEX_FILE and friends) set to the real repository. A test that
// runs `git init`/`git config`/`git commit` in a temp directory and starts that child without an explicit environment therefore
// writes to the REAL repository: on 2026-11-14 three pushes set core.bare=true and user.name=T in the shared clone's config and
// added a commit "one" to the pushed branch. Deleting keys from `process.env` inside a test is not enough, because Bun's child
// processes do not reliably see the deletion, and GIT_CONFIG* is a separate leak. The environment is sealed at the source: the
// hook builds one explicit `env` and hands it to every subprocess (`sealedGitEnv`), and tests that run git use it too
// (src/testing/git.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every variable that names a repository, an index, an object store, a config source or a git program, or that git exports to a hook.
 * Listed for documentation and for the tests; `sealedGitEnv` drops all of these because it drops every variable whose name starts
 * with GIT_. The numbered GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pairs are covered by that prefix too.
 */
export const GIT_REDIRECTING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_EXEC_PATH",
	"GIT_QUARANTINE_PATH",
	"GIT_TEMPLATE_DIR",
	"GIT_SHALLOW_FILE",
	"GIT_GRAFT_FILE",
	"GIT_REPLACE_REF_BASE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_INDEX_VERSION",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_REFLOG_ACTION",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_COMMITTER_DATE",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
] as const;

export type Env = Record<string, string>;

/** `base` without a single GIT_* variable (and without undefined values), as a plain object to pass as a subprocess's `env`. */
export function sealedGitEnv(base: Record<string, string | undefined> = process.env): Env {
	const env: Env = {};
	for (const [name, value] of Object.entries(base))
		if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
	return env;
}

/** The identity and branch name the repositories a test makes use. They come from `-c` flags and the scratch global config, never from a real file. */
export const GIT_TEST_IDENTITY = [
	"user.name=Test",
	"user.email=test@example.invalid",
	"init.defaultBranch=main",
] as const;

/** A scratch home under TMPDIR holding only a global git config with the test identity. The caller removes `root`. */
export function scratchGitHome(): { root: string; home: string; env: Env } {
	const root = mkdtempSync(join(tmpdir(), "chamberlain-git-home-"));
	const home = join(root, "home");
	try {
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n",
		);
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	const env: Env = {
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
	};
	return { root, home, env };
}

/**
 * The environment for a test run: sealed, with a scratch HOME and global git config and no system config. The developer's own
 * `<HOME>/bin` leaves the PATH here, while the original HOME is still known: the test preload (src/test-setup.ts) removes
 * `<HOME>/bin` too, but by the time it runs HOME is already the scratch home, so it could no longer name the original.
 */
export function testRunEnv(base: Record<string, string | undefined>, scratch: { env: Env }): Env {
	const env = { ...sealedGitEnv(base), ...scratch.env };
	if (base.HOME && env.PATH !== undefined)
		env.PATH = env.PATH.split(":")
			.filter((entry) => entry !== `${base.HOME}/bin`)
			.join(":");
	return env;
}

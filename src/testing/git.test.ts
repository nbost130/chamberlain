import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitTestEnv, tryGit } from "./git.ts";

const made: string[] = [];
const tmp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("the test git helper", () => {
	test("makes a commit with the test identity, from -c flags and no config file", () => {
		const repo = tmp("git-helper-");
		git(repo, "init", "-q");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", "a.txt");
		git(repo, "commit", "-q", "-m", "one");
		expect(git(repo, "log", "-1", "--format=%an <%ae> %s")).toBe("Test <test@example.invalid> one");
		expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
		expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("[user]");
	});

	test("a failing git command is reported, not thrown, by tryGit and thrown by git", () => {
		const repo = tmp("git-helper-");
		expect(tryGit(repo, "rev-parse", "HEAD").ok).toBe(false);
		expect(() => git(repo, "rev-parse", "HEAD")).toThrow("rev-parse HEAD failed");
	});

	test("refuses a repository outside TMPDIR and a relative path", () => {
		expect(() => git(process.cwd(), "status")).toThrow("only in a temp directory");
		expect(() => git("relative/repo", "status")).toThrow("only in a temp directory");
	});

	test("an environment that points git at another repository changes nothing there", () => {
		const sentinel = tmp("git-sentinel-");
		git(sentinel, "init", "-q");
		const config = readFileSync(join(sentinel, ".git", "config"), "utf8");
		const gitDir = join(sentinel, ".git");
		const leaked = {
			GIT_DIR: gitDir,
			GIT_WORK_TREE: sentinel,
			GIT_COMMON_DIR: gitDir,
			GIT_CONFIG: join(gitDir, "config"),
			GIT_CONFIG_GLOBAL: join(gitDir, "config"),
			GIT_CONFIG_PARAMETERS: "'core.bare=true'",
		};
		const saved = Object.fromEntries(Object.keys(leaked).map((k) => [k, process.env[k]]));
		Object.assign(process.env, leaked);
		try {
			const repo = tmp("git-helper-");
			git(repo, "init", "-q");
			git(repo, "config", "leaked.key", "yes");
			git(repo, "commit", "-q", "--allow-empty", "-m", "one");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("one");
			expect(readFileSync(join(repo, ".git", "config"), "utf8")).toContain("leaked");
		} finally {
			for (const [k, v] of Object.entries(saved))
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
		}
		expect(readFileSync(join(sentinel, ".git", "config"), "utf8")).toBe(config);
		expect(tryGit(sentinel, "log", "-1").ok).toBe(false); // still no commits: the sentinel was never committed to
	});

	test("the environment it hands git has no GIT_* of the caller's and no system or global config", () => {
		const env = gitTestEnv({ GIT_DIR: "x", GIT_CONFIG_COUNT: "1", PATH: "/bin" });
		expect(env).toEqual({ PATH: "/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
	});
});

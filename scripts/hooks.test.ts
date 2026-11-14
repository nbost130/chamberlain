import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitTestEnv } from "../src/testing/git.ts";
import { GIT_REDIRECTING, sealedGitEnv } from "./git-env.ts";
import { droppedJobs, isBypass, pushedShas } from "./hooks.ts";
import { releaseLock, takeLock } from "./hooks-lock.ts";
import { runTests, snapshotCommit, snapshotIndex } from "./hooks-run.ts";

const made: string[] = [];
/** A fresh temporary directory, removed when the file's tests are done. */
const tmp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("droppedJobs", () => {
	test("names each variable that drops jobs", () => {
		expect(droppedJobs({ LEFTHOOK_EXCLUDE: "test", LEFTHOOK_ONLY: "biome" })).toHaveLength(2);
	});
	test("allows an environment that drops nothing", () => {
		expect(droppedJobs({ LEFTHOOK_EXCLUDE: "", PATH: "/bin" })).toEqual([]);
	});
});

describe("isBypass", () => {
	const commit = { parents: 1, action: "commit", tree: "aaa" };
	test("a tree no pre-commit run verified is a bypass", () => {
		expect(isBypass(commit, ["bbb"])).toBe(true);
	});
	test("a verified tree is not", () => {
		expect(isBypass(commit, ["bbb", "aaa"])).toBe(false);
	});
	test("merges and replays make commits without pre-commit and are not bypasses", () => {
		expect(isBypass({ ...commit, parents: 2 }, [])).toBe(false);
		expect(isBypass({ ...commit, action: "cherry-pick" }, [])).toBe(false);
		expect(isBypass({ ...commit, action: "rebase (continue)" }, [])).toBe(false);
	});
});

describe("pushedShas", () => {
	const zero = "0".repeat(40);
	test("takes the local sha of each pushed ref, once", () => {
		const stdin = `refs/heads/a aaa1 refs/heads/a ${zero}\nrefs/heads/b bbb2 refs/heads/b ccc3\nrefs/heads/c aaa1 refs/heads/c ${zero}\n`;
		expect(pushedShas(stdin)).toEqual(["aaa1", "bbb2"]);
	});
	test("leaves out a deletion and reads empty input as nothing", () => {
		expect(pushedShas(`(delete) ${zero} refs/heads/gone ccc3\n`)).toEqual([]);
		expect(pushedShas("")).toEqual([]);
	});
});

describe("the heavy-work lock", () => {
	const dir = tmp("hooks-lock-test-");
	const lock = join(dir, "heavy.lock");
	afterEach(() => rmSync(lock, { force: true }));

	test("a held lock is not taken, and only its owner releases it", () => {
		expect(takeLock(lock)).toBe(true);
		expect(takeLock(lock)).toBe(false);
		writeFileSync(lock, String(process.pid + 1));
		releaseLock(lock);
		expect(existsSync(lock)).toBe(true);
		writeFileSync(lock, String(process.pid));
		releaseLock(lock);
		expect(existsSync(lock)).toBe(false);
	});

	test("a lock whose owner is gone is reclaimed on the next try", () => {
		const gone = Bun.spawnSync(["true"]);
		writeFileSync(lock, String(gone.pid ?? 2 ** 22 - 1));
		expect(takeLock(lock)).toBe(false);
		expect(takeLock(lock)).toBe(true);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
	});

	test("leaves no stray files behind", () => {
		takeLock(lock);
		takeLock(lock);
		expect(readdirSync(dir)).toEqual(["heavy.lock"]);
	});
});

describe("snapshots", () => {
	const repo = tmp("hooks-snap-test-");
	let first = "";
	beforeAll(() => {
		git(repo, "init", "-q");
		writeFileSync(join(repo, "a.ts"), "const v = 1;\n");
		git(repo, "add", "a.ts");
		git(repo, "commit", "-q", "-m", "one");
		first = git(repo, "rev-parse", "HEAD");
	});

	test("the index snapshot holds the staged bytes, not the working tree", () => {
		writeFileSync(join(repo, "a.ts"), 'const v: number = "bad";\n');
		git(repo, "add", "a.ts");
		writeFileSync(join(repo, "a.ts"), "const v = 2;\n");
		const dir = tmp("hooks-snap-out-");
		expect(snapshotIndex(repo, dir, gitTestEnv())).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe('const v: number = "bad";\n');
	});

	test("the commit snapshot holds that commit, whatever is checked out", () => {
		const dir = tmp("hooks-snap-out-");
		expect(snapshotCommit(repo, first, dir, gitTestEnv())).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const v = 1;\n");
	});
});

describe("sealedGitEnv", () => {
	test("drops every variable git exports to a hook or reads to find a repository or a config, and keeps the rest", () => {
		const leaky: Record<string, string> = { PATH: "/bin", HOME: "/home/x", TMPDIR: "/scratch" };
		for (const name of GIT_REDIRECTING) leaky[name] = "leaked";
		Object.assign(leaky, {
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "T",
			GIT_CONFIG_KEY_17: "k",
			GIT_CONFIG_VALUE_17: "v",
		});
		expect(sealedGitEnv(leaky)).toEqual({ PATH: "/bin", HOME: "/home/x", TMPDIR: "/scratch" });
	});
	test("leaves out undefined values", () => {
		expect(sealedGitEnv({ A: "1", B: undefined })).toEqual({ A: "1" });
	});
});

/** Every file under `dir` (bytes, symlink targets, directory names) as one digest per path: what "unchanged" means for the sentinel. */
function digest(dir: string, prefix = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		const key = `${prefix}${name}`;
		const st = lstatSync(path);
		if (st.isDirectory()) {
			out[`${key}/`] = "dir";
			Object.assign(out, digest(path, `${key}/`));
		} else if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
		else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
	}
	return out;
}

describe("the test-launch path cannot reach the repository that launched the hook", () => {
	// A test written the way the leaking one was: plain `git` in a temp repository, no environment passed on, run through both
	// of the ways a test starts a child (Bun.spawnSync and node:child_process).
	const leakyTest = `
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
test("the launch handed this run no GIT_* of the hook's, only the scratch config", () => {
	const git = Object.keys(process.env).filter((name) => name.startsWith("GIT_")).sort();
	expect(git).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
	expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
	expect(process.env.GIT_CONFIG_GLOBAL).toBe(process.env.HOME + "/.gitconfig");
	expect(process.env.HOME!.startsWith(tmpdir())).toBe(true);
	expect((process.env.PATH ?? "").split(":")).not.toContain(process.env.ORIGINAL_HOME + "/bin");
});
test("makes a repository the careless way", () => {
	const repo = mkdtempSync(tmpdir() + "/leaky-");
	const sh = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
	const node = (...args: string[]) => spawnSync("git", args, { cwd: repo });
	expect(sh("init", "-q").exitCode).toBe(0);
	sh("config", "user.email", "t@example.com");
	sh("config", "user.name", "T");
	sh("config", "--global", "leaked.global", "yes");
	node("config", "leaked.node", "yes");
	writeFileSync(repo + "/a.ts", "const v = 1;\\n");
	sh("add", "a.ts");
	expect(sh("commit", "-q", "-m", "one").exitCode).toBe(0);
	node("commit", "-q", "--allow-empty", "-m", "two");
	node("update-ref", "refs/heads/leaked", "HEAD");
	sh("config", "core.bare", "true");
});
`;

	/** The variables of each family, aimed at the sentinel at `gitDir` (its working tree is `tree`). */
	const families: Record<string, (gitDir: string, tree: string) => Record<string, string>> = {
		"repository location (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_PREFIX)": (
			gitDir,
			tree,
		) => ({
			GIT_DIR: gitDir,
			GIT_WORK_TREE: tree,
			GIT_COMMON_DIR: gitDir,
			GIT_INDEX_FILE: join(gitDir, "index"),
			GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
			GIT_PREFIX: "",
		}),
		"GIT_DIR alone": (gitDir) => ({ GIT_DIR: gitDir }),
		"GIT_COMMON_DIR alone": (gitDir) => ({ GIT_COMMON_DIR: gitDir }),
		GIT_CONFIG: (gitDir) => ({ GIT_CONFIG: join(gitDir, "config") }),
		"GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM": (gitDir) => ({
			GIT_CONFIG_GLOBAL: join(gitDir, "config"),
			GIT_CONFIG_SYSTEM: join(gitDir, "config"),
			GIT_CONFIG_NOSYSTEM: "0",
		}),
		"GIT_CONFIG_COUNT with KEY/VALUE pairs": () => ({
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "Leaked",
			GIT_CONFIG_KEY_1: "core.bare",
			GIT_CONFIG_VALUE_1: "true",
		}),
		"GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, GIT_EXEC_PATH, GIT_TEMPLATE_DIR, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_INDEX_FILE and author and committer identity":
			(gitDir) => ({
				GIT_NAMESPACE: "leaked",
				GIT_CEILING_DIRECTORIES: gitDir,
				GIT_EXEC_PATH: gitDir,
				GIT_TEMPLATE_DIR: gitDir,
				GIT_ALTERNATE_OBJECT_DIRECTORIES: gitDir,
				GIT_INDEX_FILE: join(gitDir, "index"),
				GIT_AUTHOR_NAME: "Leaked",
				GIT_AUTHOR_EMAIL: "leaked@example.com",
				GIT_COMMITTER_NAME: "Leaked",
				GIT_COMMITTER_EMAIL: "leaked@example.com",
			}),
		GIT_CONFIG_PARAMETERS: () => ({ GIT_CONFIG_PARAMETERS: "'core.bare=true' 'user.email=leaked@example.com'" }),
	};

	for (const [family, vars] of Object.entries(families)) {
		test(`${family}, aimed at a sentinel repository, leaves it byte for byte unchanged`, async () => {
			const sentinel = tmp("hooks-sentinel-");
			git(sentinel, "init", "-q", "-b", "main");
			writeFileSync(join(sentinel, "keep.txt"), "sentinel\n");
			git(sentinel, "add", "keep.txt");
			git(sentinel, "commit", "-q", "-m", "sentinel commit");
			const gitDir = join(sentinel, ".git");
			const before = digest(sentinel);
			const config = readFileSync(join(gitDir, "config"), "utf8");
			const refs = git(sentinel, "for-each-ref");

			const project = tmp("hooks-leaky-project-");
			writeFileSync(join(project, "leaky.test.ts"), leakyTest);
			const code = await runTests(["bun", "test"], project, {
				...process.env,
				// The developer's own home and its bin on the PATH: the launch must take that bin off the PATH.
				HOME: "/home/original",
				ORIGINAL_HOME: "/home/original",
				PATH: `/home/original/bin:${process.env.PATH}`,
				...vars(gitDir, sentinel),
			});

			// The sentinel first: a launch that reached it must fail on that, not only on the run's exit code.
			expect(readFileSync(join(gitDir, "config"), "utf8")).toBe(config);
			expect(git(sentinel, "for-each-ref")).toBe(refs);
			expect(digest(sentinel)).toEqual(before);
			expect(code).toBe(0);
		}, 60_000);
	}
});

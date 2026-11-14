import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedJobs, isBypass, pushedShas, snapshotCommit, snapshotIndex } from "./hooks.ts";
import { releaseLock, takeLock } from "./hooks-lock.ts";

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
	const sh = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
	sh("init", "-q");
	sh("config", "user.email", "t@example.com");
	sh("config", "user.name", "T");
	writeFileSync(join(repo, "a.ts"), "const v = 1;\n");
	sh("add", "a.ts");
	sh("commit", "-q", "-m", "one");
	const first = sh("rev-parse", "HEAD").stdout.toString().trim();

	test("the index snapshot holds the staged bytes, not the working tree", () => {
		writeFileSync(join(repo, "a.ts"), 'const v: number = "bad";\n');
		sh("add", "a.ts");
		writeFileSync(join(repo, "a.ts"), "const v = 2;\n");
		const dir = tmp("hooks-snap-out-");
		expect(snapshotIndex(repo, dir)).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe('const v: number = "bad";\n');
	});

	test("the commit snapshot holds that commit, whatever is checked out", () => {
		const dir = tmp("hooks-snap-out-");
		expect(snapshotCommit(repo, first, dir)).toBe(true);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const v = 1;\n");
	});
});

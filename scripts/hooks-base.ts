/** What the hook scripts share: running git, the clone's hook state directory, reading a file's lines, and how long a lock may be waited for. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_TIMEOUT_MS = 600_000;

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

export function readLines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

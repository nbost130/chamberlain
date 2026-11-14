/** The smoke test's setup: the binary under test, its scratch directories and environment, and the checks every step reports through. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
const input = process.argv[2];
if (!input || !existsSync(input)) {
	console.error("usage: bun scripts/smoke.ts <binary | chamberlain-<version>-<os>-<arch>.tar.gz>");
	process.exit(2);
}

export const work = mkdtempSync(join(tmpdir(), "chamberlain-smoke-"));
export const empty = join(work, "empty"); // the working directory of every run: nothing is in it
export const conf = join(work, "conf");
export const state = join(work, "state");
for (const d of [empty, state]) mkdirSync(d, { recursive: true });
mkdirSync(conf, { recursive: true, mode: 0o700 });
let binary = resolve(input);
if (basename(binary).endsWith(".tar.gz")) {
	const unpacked = join(work, "unpacked");
	mkdirSync(unpacked);
	const t = Bun.spawnSync(["tar", "-xzf", binary, "-C", unpacked]);
	if (t.exitCode !== 0) throw Error(`tar failed: ${t.stderr.toString()}`);
	binary = join(unpacked, "chamberlain");
}
export const bin = binary;

export const port = 40000 + Math.floor(Math.random() * 20000);
writeFileSync(join(conf, "config.json"), JSON.stringify({ schemaVersion: 1, web: { host: "127.0.0.1", port } }), {
	mode: 0o600,
});
export const env: Record<string, string> = {
	PATH: "/usr/bin:/bin",
	HOME: work,
	CHAMBERLAIN_CONF: conf,
	CHAMBERLAIN_STATE: state,
	CHAMBERLAIN_T3_STATE_DB: join(work, "no-t3.sqlite"),
};
export const exec = (...args: string[]) =>
	Bun.spawnSync([bin, ...args], { cwd: empty, env, stdout: "pipe", stderr: "pipe" });

let failed = false;
export const hasFailed = () => failed;
const ok = (what: string) => console.log(`ok   ${what}`);
const bad = (what: string, detail = "") => {
	failed = true;
	console.log(`FAIL ${what}${detail ? `\n       ${detail.split("\n").join("\n       ")}` : ""}`);
};
export const check = (what: string, cond: boolean, detail = "") => (cond ? ok(what) : bad(what, detail));

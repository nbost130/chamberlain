/**
 * Test preload (bunfig.toml): one isolated world per `bun test` run, whatever the developer's shell and home directory hold.
 *
 *  - TMPDIR points at a scratch root made here, so every fixture and every child process puts its temp dirs under one directory that is
 *    removed when the run ends. (Without it a tmpfs /tmp can run out of inodes long before it runs out of space.)
 *  - HOME, CHAMBERLAIN_CONF, CHAMBERLAIN_STATE and the XDG base directories are scratch directories under that root. A test that forgets to
 *    set its own can therefore never read the developer's settings.json, tokens or database, or write to them.
 *  - Every CHAMBERLAIN_*, ALERT_DESK_* and DESK_* variable the shell holds is dropped, and `<HOME>/bin` is off the PATH, so a live alert
 *    command (settings.json `alertCommand`, CHAMBERLAIN_ALERT_CMD) cannot be reached from a test.
 *  - The alert command is a sentinel that only records its call. A test that raises an alarm through a real engine must pass `noAlert`
 *    (the `noAlert` helper in the testing directory) or its own command; one that does not leaves a marker, and the run fails at the end with what was called.
 *    (src/test-isolation.test.ts holds these promises.)
 */
import { afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const realHome = process.env.HOME ?? "";
const root = mkdtempSync(`${tmpdir()}/chamberlain-test-run-`);
process.env.TMPDIR = root;

const home = `${root}/home`;
const conf = `${root}/conf`;
const state = `${root}/state`;
for (const d of [home, conf, state]) mkdirSync(d, { mode: 0o700 });
// git needs an identity for the repositories some tests make; the scratch home has none of its own.
writeFileSync(`${home}/.gitconfig`, "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");

for (const k of Object.keys(process.env)) if (/^(CHAMBERLAIN_|ALERT_DESK_|DESK_)/.test(k) || k === "CLAUDE_CONFIG_DIR") delete process.env[k];
Object.assign(process.env, {
	HOME: home,
	CHAMBERLAIN_CONF: conf,
	CHAMBERLAIN_STATE: state,
	XDG_CONFIG_HOME: `${home}/.config`,
	XDG_STATE_HOME: `${home}/.local/state`,
	XDG_CACHE_HOME: `${home}/.cache`,
	XDG_DATA_HOME: `${home}/.local/share`,
});
if (realHome) process.env.PATH = (process.env.PATH ?? "").split(":").filter((p) => p && p !== `${realHome}/bin`).join(":");

/** Where the sentinel writes one line per call. A run that finds this file at its end has failed. */
export const ALERT_MARKER = `${root}/alert-called`;
const sentinel = `${root}/alert-sentinel.sh`;
writeFileSync(sentinel, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ALERT_MARKER}'\n`);
chmodSync(sentinel, 0o755);
process.env.CHAMBERLAIN_ALERT_CMD = sentinel;
process.env.CHAMBERLAIN_TEST_ALERT_MARKER = ALERT_MARKER;

let removed = false;
const cleanup = () => {
	if (removed) return;
	removed = true;
	if (existsSync(ALERT_MARKER)) {
		const calls = readFileSync(ALERT_MARKER, "utf8").trim().split("\n");
		console.error(`\nFAIL: ${calls.length} test(s) ran the alert command. A test that raises an alarm must pass \`alert: noAlert\` (the noAlert helper in the testing directory). Calls:\n${calls.map((c) => `  ${c.slice(0, 200)}`).join("\n")}`);
		process.exitCode = 1;
	}
	rmSync(root, { recursive: true, force: true });
};
afterAll(cleanup);
// A run that is killed part-way (a timeout, ^C) still takes its root with it. A child process that outlives the runner
// loses its temp dir here; that is deliberate: a test must stop every process it starts, and a survivor is a test bug.
process.on("exit", cleanup);
for (const [sig, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) process.on(sig, () => { cleanup(); process.exit(code); });

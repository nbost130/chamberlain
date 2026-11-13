/**
 * Test preload (bunfig.toml): one scratch root per `bun test` run.
 *
 * The tests build their fixtures with mkdtempSync(`${tmpdir()}/...`), and the CLIs and daemons they spawn inherit
 * process.env. Pointing TMPDIR at a root made here puts every temp dir, theirs and the subprocesses', under one
 * directory that is removed when the run ends. Without it, each run left thousands of inodes behind in the system
 * temp dir, and a tmpfs /tmp can run out of inodes long before it runs out of space.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/chamberlain-test-run-`);
process.env.TMPDIR = root;

let removed = false;
const cleanup = () => {
	if (removed) return;
	removed = true;
	rmSync(root, { recursive: true, force: true });
};
afterAll(cleanup);
// A run that is killed part-way (a timeout, ^C) still takes its root with it. A child process that outlives the runner
// loses its temp dir here; that is deliberate: a test must stop every process it starts, and a survivor is a test bug.
process.on("exit", cleanup);
for (const [sig, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) process.on(sig, () => { cleanup(); process.exit(code); });

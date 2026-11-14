/**
 * Smoke test for a compiled binary: `bun scripts/smoke.ts <binary | release tarball>`.
 *
 * Runs the binary from an EMPTY temporary directory, with HOME, CHAMBERLAIN_CONF and CHAMBERLAIN_STATE pointed at scratch directories, so
 * nothing it needs can come from a checkout or from Bun: `--version`, `help`, `web --test` serving the page, its CSS and its scripts (each
 * byte for byte what src/web/static/ holds), an `ask` that a second process (the page) then reads back from the scratch database, the
 * hand-offs rendering `chamberlain <sub>` for every command they teach, and the sweep prompt embedded in the binary.
 * Exits 1 at the first thing that is wrong. Needs a binary built for the machine it runs on.
 */
import { rmSync } from "node:fs";
import { smokeBasics, smokeBriefs, smokeConfig, smokeDaemon, smokeHandoffs, smokeSweepPrompt } from "./smoke-cli.ts";
import { bin, empty, hasFailed, work } from "./smoke-lib.ts";
import { smokeWeb } from "./smoke-web.ts";

try {
	console.log(`binary: ${bin}\ncwd:    ${empty} (empty)\n`);
	smokeBasics();
	smokeBriefs();
	await smokeWeb();
	await smokeDaemon();
	smokeHandoffs();
	smokeConfig();
	smokeSweepPrompt();
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log(hasFailed() ? "\nsmoke test FAILED" : "\nsmoke test passed");
process.exit(hasFailed() ? 1 : 0);

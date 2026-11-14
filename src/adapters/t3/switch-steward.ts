/**
 * Make this thread the wake target: the last step of a hand-off, and the flip itself.
 * The old URL stays in wake-url.prev, so rollback is one rename.
 *
 *   bun src/adapters/t3/switch-steward.ts <threadId>
 */
import { chmodSync, copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { CONF } from "../../core/config.ts";

export function main(argv: string[] = process.argv.slice(2)) {
	const threadId = argv[0];
	if (!threadId) {
		console.error("usage: switch-steward.ts <threadId>");
		process.exit(2);
	}
	const next = `${CONF}/wake-url.steward`;
	if (!existsSync(next)) throw Error("no wake-url.steward: the new thread has not written its webhook");
	if (existsSync(`${CONF}/wake-url`)) copyFileSync(`${CONF}/wake-url`, `${CONF}/wake-url.prev`);
	chmodSync(next, 0o600);
	renameSync(next, `${CONF}/wake-url`);
	writeFileSync(`${CONF}/steward-thread`, `${threadId}\n`, { mode: 0o600 });
	console.log("steward switched");
}

if (import.meta.main) main();

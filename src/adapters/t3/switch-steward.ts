/**
 * Make this thread the wake target: the last step of a hand-off, and the flip itself.
 * The new Steward thread writes its webhook to secrets/wake-url.steward. The old URL stays in secrets/wake-url.prev, so rollback is one rename,
 * and the thread id is set in config.json (`threads.steward`).
 *
 *   bun src/adapters/t3/switch-steward.ts <threadId>
 */
import { chmodSync, copyFileSync, renameSync } from "node:fs";
import { CONF } from "../../core/config.ts";
import { setThread } from "../../core/config-migrate.ts";
import { ensureSecretsDir, secretPath } from "../../core/layout.ts";

export function main(argv: string[] = process.argv.slice(2)) {
	const threadId = argv[0];
	if (!threadId) {
		console.error("usage: switch-steward.ts <threadId>");
		process.exit(2);
	}
	const next = secretPath(CONF, "wake-url.steward");
	if (!next)
		throw Error(
			"no secrets/wake-url.steward: the new thread has not written its webhook (write it into secrets/, not the config directory)",
		);
	const dir = ensureSecretsDir(CONF);
	const current = secretPath(CONF, "wake-url");
	if (current) {
		copyFileSync(current, `${dir}/wake-url.prev`);
		chmodSync(`${dir}/wake-url.prev`, 0o600);
	}
	chmodSync(next, 0o600);
	renameSync(next, `${dir}/wake-url`);
	setThread(CONF, "steward", threadId);
	console.log("steward switched");
}

if (import.meta.main) main();

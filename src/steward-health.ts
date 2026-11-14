/** Prints the Steward's health: `bun src/steward-health.ts`. Read-only. Measures the transcript the Steward's adapter points at. */

import { homeAdapter } from "./adapters/index.ts";
import { has } from "./core/adapter.ts";
import { CONF, STATE } from "./core/config.ts";
import { liveHealth } from "./core/steward-health.ts";

/** Prints the Steward's health; it takes no arguments. */
export async function main(_argv: string[] = process.argv.slice(2)) {
	try {
		const { adapter } = homeAdapter({ conf: CONF, state: STATE });
		if (!has(adapter, "transcriptPath")) throw Error(`the ${adapter.id} adapter has no transcript to measure`);
		console.log((await liveHealth(() => adapter.transcriptPath!())).report);
	} catch (e) {
		console.error(`Steward health: WATCH — measurement unavailable (${String(e)})`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();

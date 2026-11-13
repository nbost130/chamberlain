/** Prints the Steward's health: `bun src/steward-health.ts`. Read-only. Measures the transcript the Steward's adapter points at. */
import { CONF, STATE } from "./core/config.ts";
import { has } from "./core/adapter.ts";
import { liveHealth } from "./core/steward-health.ts";
import { homeAdapter } from "./adapters/index.ts";

try {
	const { adapter } = homeAdapter({ conf: CONF, state: STATE });
	if (!has(adapter, "transcriptPath")) throw Error(`the ${adapter.id} adapter has no transcript to measure`);
	console.log((await liveHealth(() => adapter.transcriptPath!())).report);
} catch (e) {
	console.error(`Steward health: WATCH — measurement unavailable (${String(e)})`);
	process.exitCode = 1;
}

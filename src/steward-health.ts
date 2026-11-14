/**
 * Prints the Steward's health: `bun src/steward-health.ts`. Read-only. Measures the transcript the Steward's adapter points at.
 *
 *   steward-health                                   the live health verdict
 *   steward-health tokens [--json]                   tokens per wake by kind, a full sweep's cost and the context trend (needs stewardTokens on)
 *   steward-health tokens backfill [--dir <d>] [<transcript.jsonl> ...]
 *                                                    read past Steward transcripts into the database (default: every Steward transcript in
 *                                                    the current Steward's project folder); idempotent
 */

import { homeAdapter } from "./adapters/index.ts";
import { has } from "./core/adapter.ts";
import { CONF, compactTokens, STATE } from "./core/config.ts";
import { defaultStore } from "./core/default-store.ts";
import { setting } from "./core/layout.ts";
import { HEALTH_CONFIG, liveHealth } from "./core/steward-health.ts";
import {
	backfill,
	findStewardTranscripts,
	parseBackfillArgs,
	transcriptDir,
	usageReport,
} from "./core/steward-tokens.ts";

const OFF =
	'Steward token metering is off. Turn it on with "stewardTokens": true in config.json (or CHAMBERLAIN_STEWARD_TOKENS=1); see docs/CONFIGURATION.md.';

async function tokens(argv: string[]) {
	if (setting("stewardTokens", CONF) !== true) {
		console.log(OFF);
		return;
	}
	const store = defaultStore();
	try {
		if (argv[0] === "backfill") {
			const args = parseBackfillArgs(argv.slice(1));
			let paths = args.files;
			if (!paths.length) {
				let dir = args.dir;
				if (!dir) {
					const { adapter } = homeAdapter({ conf: CONF, state: STATE });
					if (!has(adapter, "transcriptPath"))
						throw Error(`the ${adapter.id} adapter has no transcript; pass --dir or the transcript files`);
					dir = transcriptDir(await adapter.transcriptPath());
				}
				paths = await findStewardTranscripts(dir);
			}
			const r = await backfill(store, paths);
			console.log(
				`Backfilled ${r.sessions.length} Steward sessions: ${r.rows} turns, ${r.wakes} of them wakes. Run it again any time; it rewrites the same rows.`,
			);
			return;
		}
		if (argv.length && argv[0] !== "--json") throw Error(`unknown argument ${argv[0]}`);
		const r = usageReport(store, { compactAt: compactTokens(HEALTH_CONFIG.compactContext) });
		console.log(argv[0] === "--json" ? JSON.stringify(r.windows, null, 2) : r.text);
	} finally {
		store.close();
	}
}

/** Prints the Steward's health; `tokens` prints its token usage per wake. */
export async function main(argv: string[] = process.argv.slice(2)) {
	if (argv[0] === "tokens") {
		try {
			await tokens(argv.slice(1));
		} catch (e) {
			console.error(`Steward tokens: ${String(e)}`);
			console.error("usage: steward-health tokens [--json] | tokens backfill [--dir <dir>] [<transcript.jsonl> ...]");
			process.exitCode = 1;
		}
		return;
	}
	try {
		const { adapter } = homeAdapter({ conf: CONF, state: STATE });
		if (!has(adapter, "transcriptPath")) throw Error(`the ${adapter.id} adapter has no transcript to measure`);
		console.log((await liveHealth(() => adapter.transcriptPath())).report);
	} catch (e) {
		console.error(`Steward health: WATCH — measurement unavailable (${String(e)})`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();

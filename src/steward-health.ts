/**
 * Prints the Steward's health: `bun src/steward-health.ts`. Read-only. Measures the transcript the Steward's adapter points at.
 *
 *   steward-health                                   the live health verdict
 *   steward-health tokens [--json]                   tokens per wake by kind, a full sweep's cost and the context trend (needs stewardTokens on)
 *   steward-health flow [--days <n>] [--json]          per UTC day: where the Steward's turns came from, notes and answers held, digests,
 *                                                    stale reports given up, reads per digest item and context (needs stewardTokens on)
 *   steward-health tokens backfill [--dir <d>] [<transcript.jsonl> ...]
 *                                                    read past Steward transcripts into the database (default: every Steward transcript in
 *                                                    the current Steward's project folder); idempotent
 */

import { homeAdapter } from "./adapters/index.ts";
import { has } from "./core/adapter/adapter-conformance.ts";
import { CONF, STATE } from "./core/config/config.ts";
import { contextGuardConfig, setting, thread } from "./core/config/layout.ts";
import { flowReport, formatFlow } from "./core/steward/steward-flow.ts";
import { guardedHealth } from "./core/steward/steward-health.ts";
import { usageReport } from "./core/steward/steward-report.ts";
import { backfill, findStewardTranscripts, parseBackfillArgs, transcriptDir } from "./core/steward/steward-tokens.ts";
import { defaultStore } from "./core/store/default-store.ts";

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
		const bad = argv.find((arg) => !["--json", "--transcript"].includes(arg));
		if (bad) throw Error(`unknown argument ${bad}`);
		const r = usageReport(store, {
			compactAt: contextGuardConfig(CONF).steward.compactAt,
			transcriptOnly: argv.includes("--transcript"),
		});
		console.log(argv.includes("--json") ? JSON.stringify(r.windows, null, 2) : r.text);
	} finally {
		store.close();
	}
}

/** `flow [--days <n>] [--json]`: the day-by-day flow report. */
function flow(argv: string[]) {
	if (setting("stewardTokens", CONF) !== true) {
		console.log(OFF);
		return;
	}
	let days = 7;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--json") json = true;
		else if (argv[i] === "--days" && /^\d+$/.test(argv[i + 1] ?? "")) days = Number(argv[++i]);
		else throw Error(`unknown argument ${argv[i]}`);
	}
	const store = defaultStore();
	try {
		const r = flowReport(store, { days });
		console.log(json ? JSON.stringify(r, null, 2) : formatFlow(r));
	} finally {
		store.close();
	}
}

/** Prints the Steward's health; `tokens` prints its token usage per wake, `flow` the day-by-day flow. */
export async function main(argv: string[] = process.argv.slice(2)) {
	if (argv[0] === "flow") {
		try {
			flow(argv.slice(1));
		} catch (e) {
			console.error(`Steward flow: ${String(e)}`);
			console.error("usage: steward-health flow [--days <n>] [--json]");
			process.exitCode = 1;
		}
		return;
	}
	if (argv[0] === "tokens") {
		try {
			await tokens(argv.slice(1));
		} catch (e) {
			console.error(`Steward tokens: ${String(e)}`);
			console.error(
				"usage: steward-health tokens [--json] [--transcript] | tokens backfill [--dir <dir>] [<transcript.jsonl> ...]",
			);
			process.exitCode = 1;
		}
		return;
	}
	try {
		const { adapter } = homeAdapter({ conf: CONF, state: STATE });
		const id = thread(CONF, "steward");
		const health = await guardedHealth({
			find: has(adapter, "transcriptPath") ? () => adapter.transcriptPath() : undefined,
			meter: id && has(adapter, "stewardMeter") ? adapter.stewardMeter(id, 0, true) : undefined,
			thread: id,
			probe: adapter.stewardProbe?.(),
			policy: contextGuardConfig(CONF).steward,
		});
		console.log(health.report);
	} catch (e) {
		console.error(`Steward health: WATCH — measurement unavailable (${String(e)})`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();

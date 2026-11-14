/**
 * How long wakes sat before the Steward started on them, and how long its turns ran. Read-only: it reads the daemon's
 * event log (the `events` table of chamberlain.db, with SQL) and T3's state database and writes nothing.
 *
 *   bun src/adapters/t3/queue-waits.ts [--hours N] [--json] [--store FILE] [--db FILE] [--steward THREAD_ID]
 *
 * Where each number comes from:
 * - When a wake was created: the delivered event in the event log carries `queuedAt` (and `kind`, `thread`) since this
 *   tool was added. Older records carry none, but the delivery ID of a thread wake or a sweep ends in the millisecond
 *   it was made, so that is read from the ID (shown as "from the delivery ID"). Anything else, such as an answer wake
 *   before `queuedAt` was recorded, has no creation time and is counted as not recorded, never guessed.
 * - When the Steward started on it: T3's run for that wake. A run is matched to a wake by time alone: the run was
 *   requested in the seconds before the delivered record was written. The run table has no link back to the wake.
 *   A wake with no such run is reported as unmatched.
 * - Turn length: the Steward's runs with both a start and a completion, whatever started them.
 */
import { existsSync } from "node:fs";
import { CONF, STATE } from "../../core/config.ts";
import { thread } from "../../core/layout.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { dbPath as storeDbPath } from "../../core/store.ts";
import {
	analyze,
	type Delivered,
	type Report,
	type Run,
	readRuns,
	type Stat,
	wakesFrom,
} from "./queue-waits-analysis.ts";
import { t3StateDbPath } from "./settings.ts";

const dur = (ms: number) =>
	ms < 90_000
		? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
		: ms < 90 * 60_000
			? `${(ms / 60_000).toFixed(1)}m`
			: `${(ms / 3600_000).toFixed(1)}h`;
const line = (label: string, s: Stat | undefined) =>
	`${label.padEnd(34)} ${s ? `n=${s.n}  p50 ${dur(s.p50)}  p90 ${dur(s.p90)}  max ${dur(s.max)}` : "no data"}`;

export function format(r: Report): string {
	return [
		`Queue waits, last ${r.hours}h (${r.since} to ${r.until})`,
		`Wakes posted: ${r.wakes.posted}; matched to a Steward run: ${r.wakes.matched}`,
		"",
		line("Wait before the Steward started", r.totalWait),
		line("  held by chamberlain (digest hold)", r.heldWait),
		line("  queued in T3 behind other turns", r.t3Wait),
		line("Steward turn length", r.turns),
		"",
		"5 worst waits:",
		...(r.worst.length
			? r.worst.map(
					(w, i) =>
						`  ${i + 1}. ${dur(w.waitMs)}  ${w.kind}  ${w.thread ?? "(no thread)"}  ${w.deliveryId}  created ${new Date(w.createdAt).toISOString()}`,
				)
			: ["  none measured"]),
		"",
		"Not measured / how to read:",
		...r.notes.map((n) => `  - ${n}`),
	].join("\n");
}

function arg(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[] = process.argv.slice(2)) {
	const hours = Number(arg(argv, "--hours") ?? 24);
	if (!Number.isFinite(hours) || hours <= 0) {
		console.error("--hours must be a positive number");
		process.exit(2);
	}
	const storeFile = arg(argv, "--store") ?? storeDbPath(STATE);
	const dbPath = arg(argv, "--db") ?? t3StateDbPath();
	let steward = arg(argv, "--steward");
	if (!steward) {
		steward = thread(CONF, "steward");
		if (!steward) {
			console.error("no Steward thread: pass --steward THREAD_ID");
			process.exit(2);
		}
	}
	if (!existsSync(storeFile)) {
		console.error(`database not found: ${storeFile}`);
		process.exit(2);
	}
	const now = Date.now();
	let runs: Run[];
	try {
		runs = readRuns(dbPath, steward, now - hours * 3600_000);
	} catch (e) {
		console.error(`cannot read T3 state database ${dbPath}: ${String(e).slice(0, 160)}`);
		process.exit(2);
	}
	const store = openStore(storeFile);
	const delivered = store.events.query({
		events: ["delivered"],
		since: new Date(now - hours * 3600_000).toISOString(),
	}) as Delivered[];
	store.close();
	const report = analyze(wakesFrom(delivered, now - hours * 3600_000), runs, hours, now);
	console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : format(report));
}

if (import.meta.main) main();

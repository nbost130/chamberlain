/**
 * A process that runs the config migration, for the lock tests (src/core/migrate-lock.test.ts). A slow migration is injected through the
 * migration's own `whileLocked` seam, which runs once the lock is held.
 * Usage: bun migrate-worker.ts <conf> <state> <journal> <hold-ms> <wait-ms>
 * Appends "<pid> enter <ms>" when it holds the lock and "<pid> exit <ms>" after the hold, and prints the migration report as one JSON line.
 */
import { appendFileSync } from "node:fs";
import { migrateStorage } from "../core/migrate.ts";

const [conf, state, journal, holdMs, waitMs] = [process.argv[2]!, process.argv[3]!, process.argv[4]!, Number(process.argv[5]), Number(process.argv[6])];
const report = migrateStorage({
	conf, state, lockWaitMs: waitMs,
	whileLocked: () => {
		appendFileSync(journal, `${process.pid} enter ${Date.now()}\n`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
		appendFileSync(journal, `${process.pid} exit ${Date.now()}\n`);
	},
});
console.log(JSON.stringify(report));

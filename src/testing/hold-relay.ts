/**
 * A process that tries to take the relay's lock on a database, for tests of the singleton (src/core/singleton.test.ts).
 * Usage: bun hold-relay.ts <database> <hold-ms> [start-at-epoch-ms] [flags]
 * Prints one line: "held" (then keeps the lock for hold-ms), "refused", or the error. A start time lines up many starters.
 * Flags, comma-separated:
 *   store       open the database through the Store first and keep it open, as the daemon does;
 *   twice       once held, try a second acquisition in this same process (it must be refused), and open and close another descriptor
 *               and a SQLite connection to the database (neither may release the lock); prints "held" only if the retry was refused;
 *   retry=<ms>  keep trying until held or until <ms> after the start time; once held, keep retrying locally every 20 ms while holding;
 *   spawn       once held, start two long-lived children (one by Bun.spawn, one by node:child_process) and print their pids after "held".
 */
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { Database } from "bun:sqlite";
import { holdRelayLock, RelayRunningError, type RelayLock } from "../core/singleton.ts";
import { openStore } from "../core/sqlite-store.ts";

const [db, holdMs, startAt] = [process.argv[2]!, Number(process.argv[3] ?? 1000), Number(process.argv[4] ?? 0)];
const flags = new Set((process.argv[5] ?? "").split(",").filter(Boolean));
const retryMs = Number([...flags].find((f) => f.startsWith("retry="))?.slice(6) ?? -1);
const store = flags.has("store") ? openStore(db) : undefined;

/** One local acquisition that must be refused: true if it was. */
function localRetryRefused(): boolean {
	try { holdRelayLock(db).release(); return false; } catch (e) { if (e instanceof RelayRunningError) return true; throw e; }
}

while (Date.now() < startAt) { /* spin: the starters must collide */ }
let lock: RelayLock | undefined;
try {
	for (;;) {
		try { lock = holdRelayLock(db); break; } catch (e) {
			if (!(e instanceof RelayRunningError) || retryMs < 0 || Date.now() > startAt + retryMs) throw e;
			await Bun.sleep(20);
		}
	}
	if (flags.has("twice")) {
		if (!localRetryRefused()) { console.log("held, but a second acquisition in the same process was allowed"); process.exit(1); }
		closeSync(openSync(db, "r"));
		new Database(db).close();
		store?.state.update<number>("held-by-relay", (n) => (n ?? 0) + 1);
	}
	let pids = "";
	if (flags.has("spawn")) {
		const a = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
		const b = nodeSpawn("sleep", ["60"], { stdio: "ignore", detached: true });
		b.unref();
		pids = ` ${a.pid} ${b.pid}`;
	}
	console.log(`held${pids}`);
	const until = Date.now() + holdMs;
	while (Date.now() < until) {
		if (retryMs >= 0 && !localRetryRefused()) { console.log("a local retry was allowed while holding"); process.exit(1); }
		await Bun.sleep(retryMs >= 0 ? 20 : Math.max(0, until - Date.now()));
	}
	lock.release();
} catch (e) {
	console.log(e instanceof RelayRunningError ? "refused" : `error: ${String(e)}`);
}
store?.close();

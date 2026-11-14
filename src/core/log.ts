/**
 * The one import for logging (docs/OBSERVABILITY.md section 3). `logFor(store)` is the logger of a process that holds the ledger database: it writes
 * `obs.db`, which sits beside `chamberlain.db`, and dual-writes the same line, with the same `source_key`, to the old `events` table until release C drops it.
 *
 * `Log` is the call every existing site makes, `log("fire", { ...fields })`. A `Logger` is also that call, plus the typed one:
 * `logFor(store).child({ mod: "relay", thread }).info("wake.delivered", { http: 202 })`. CHAMBERLAIN_VERBOSE also prints each old line to stdout as JSON.
 */
import { dirname } from "node:path";
import { obsPath } from "./obs/db.ts";
import { type Logger, makeLogger } from "./obs/logger.ts";
import { Obs } from "./obs/obs.ts";
import type { Store } from "./store.ts";

export type Log = (event: string, data?: Record<string, unknown>) => void;
export type { Logger };

const obses = new WeakMap<Store, Obs>();

/** The telemetry database of `store`: `obs.db` in its directory (or in memory for `:memory:`), opened once and closed with the store. */
export function obsFor(store: Store): Obs {
	const known = obses.get(store);
	if (known) return known;
	const obs = new Obs({
		path: store.path === ":memory:" ? ":memory:" : obsPath(dirname(store.path)),
		mirror: (line, key) => {
			try {
				return store.events.tryAppend(line, key);
			} finally {
				if (process.env.CHAMBERLAIN_VERBOSE) console.log(JSON.stringify(line));
			}
		},
	});
	obses.set(store, obs);
	store.onClose(() => {
		obs.close();
		obses.delete(store);
	});
	return obs;
}

/** A logger for `store`. `base` adds fields to every old line, such as `{ src: "queue-web" }`, and names the module (`src`) of the new rows. */
export function logFor(store: Store, base: Record<string, unknown> = {}): Logger {
	const mod = typeof base.src === "string" ? base.src : undefined;
	return makeLogger(obsFor(store), mod ? { mod } : {}, base);
}

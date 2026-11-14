/** The event log: one row per event in the database's `events` table (CHAMBERLAIN_VERBOSE also prints each line as JSON). */
import type { LogEvent, Store } from "./store.ts";

export type Log = (event: string, data?: Record<string, unknown>) => void;

/** A log that appends to the events table. `base` adds fields to every line, such as `{ src: "queue-web" }`. A write that fails is reported on stderr and never stops the caller. */
export function makeLog(store: Store, base: Record<string, unknown> = {}): Log {
	return (event, data = {}) => {
		const line = { t: new Date().toISOString(), ...base, event, ...data } as LogEvent;
		try {
			store.events.append(line);
		} catch (e) {
			console.error(`chamberlain: could not write the event log: ${String(e).slice(0, 160)}`);
		}
		if (process.env.CHAMBERLAIN_VERBOSE) console.log(JSON.stringify(line));
	};
}

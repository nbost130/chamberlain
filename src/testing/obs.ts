/** Telemetry-database helpers for tests: an `Obs` on an in-memory (or scratch-directory) `obs.db`, and plain reads of what it holds. */
import { Obs, type ObsOptions } from "../core/obs/obs.ts";

export const HOST = "test-host";
export const THREAD = "0b6c1a52-5a1e-4c0f-9d31-7a2f2b3c4d5e";
export const OTHER_THREAD = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

/** An Obs with a fixed host and run, on `:memory:` unless the options say otherwise. */
export const memObs = (o: Partial<ObsOptions> = {}): Obs =>
	new Obs({ path: ":memory:", host: HOST, run: "aaaaaaaaaaaa", ...o });

export type EventRow = {
	id: number;
	t: string;
	level: string;
	host: string;
	run: string;
	mod: string;
	event: string;
	corr: string | null;
	delivery: string | null;
	thread: string | null;
	source_key: string | null;
	data: string;
};

/** Every row of `events`, oldest first. */
export const eventRows = (obs: Obs, where = "1 = 1"): EventRow[] =>
	(obs.handle?.query(`SELECT * FROM events WHERE ${where} ORDER BY id`).all() ?? []) as EventRow[];

/** The data of the rows named `event`, parsed. */
export const dataOf = (obs: Obs, event: string): Record<string, unknown>[] =>
	eventRows(obs, `event = '${event}'`).map((r) => JSON.parse(r.data) as Record<string, unknown>);

/** Everything the database holds, as one string: what a leak would show up in. */
export const everything = (obs: Obs): string =>
	JSON.stringify([
		eventRows(obs),
		obs.handle?.query("SELECT * FROM obs_counter").all() ?? [],
		obs.handle?.query("SELECT * FROM migrations").all() ?? [],
	]);

/** What the telemetry writer's layers share: its options and results, a row, and the limits and patterns every layer checks against. */
import { hostname } from "node:os";
import type { OpenOptions } from "../sqlite-store.ts";
import type { LogEvent } from "../store.ts";
import type { FieldValue } from "./fields.ts";
import type { EventSpec, Level } from "./registry-spec.ts";
import type { Columns, Ctx } from "./row.ts";
import type { Rule } from "./scrub.ts";

/** Writes a line to the old table. `false` means the database was busy and nothing was written: the line waits in memory for a retry. */
type Mirror = (lines: readonly (readonly [LogEvent, string | undefined])[]) => unknown;
export type ObsOptions = {
	/** `obs.db`'s path, or `:memory:`. */
	path: string;
	host?: string;
	run?: string;
	/** Store `debug` rows too (CHAMBERLAIN_LOG=debug). */
	debug?: boolean;
	now?: () => number;
	mirror?: Mirror;
	open?: OpenOptions;
	/** Test seams: a registry and scrubber rules other than the real ones. */
	registry?: Readonly<Record<string, EventSpec>>;
	rules?: readonly Rule[];
	/** Where a complaint goes (default: stderr). */
	complain?: (message: string) => void;
};
export type Counters = { rejected: number; redacted: number; failed: number; dropped: number };
/** `t` and `sourceKey` set a derived row's time and key; `noMirror` keeps an internal row out of the old table. */
export type CallOptions = { t?: string; sourceKey?: string; noMirror?: boolean };
/** Where a call comes from and how it is made: the context its columns are taken from, and the options that set its time and key. */
export type Where = { ctx: Ctx; opts?: CallOptions };
/** What happened to a row: it is stored, it was already there (`source_key`), it waits for a retry, or it is gone. */
export type Outcome = "stored" | "ignored" | "buffered" | "dropped";

export type Row = [
	string,
	Level,
	string,
	string,
	string,
	string,
	string | null,
	string | null,
	string | null,
	string | null,
	string,
];
export type Call = {
	level: Level;
	name: string;
	data: Record<string, FieldValue>;
	cols: Columns;
	mod: string;
	t: string;
	sourceKey?: string;
};
/** A column that code (never data) sets: the host, the module. Lowercase letters, digits and dashes, short. */
export const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A derived row's key: only the shapes the ledger's own ids make (src/core/obs/ledger.ts). A later piece that derives rows from something else adds its shape here. */
export const SOURCE_KEY = /^(?:decision:\d{1,12}|item:Q-[a-z0-9]{4,16}:(?:asked|answered)|hold:[0-9a-f]{8}:closed)$/;
/** A time column: an ISO timestamp from the clock or from a derived row's ledger, nothing else. */
export const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
export const RUN = /^[0-9a-f]{12}$/;
export const BUFFER = 500;
export const RETRY_MS = 250;
export const FLUSH_MS = 5000;
export const COMPLAIN_MS = 60_000;
export const INSERT =
	"INSERT OR IGNORE INTO events (t, level, host, run, mod, event, corr, delivery, thread, source_key, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const COUNT =
	"INSERT INTO obs_counter (host, name, n) VALUES (?, ?, ?) ON CONFLICT (host, name) DO UPDATE SET n = n + excluded.n";

/** The name of this machine as a column value: lowercase letters, digits and dashes. */
export function hostName(env: NodeJS.ProcessEnv = process.env): string {
	const raw = (env.CHAMBERLAIN_HOST || hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	return raw.replace(/^-+|-+$/g, "").slice(0, 32) || "local";
}

/** The module a legacy event belongs to when its caller bound none: its name up to the first dot or dash. */
export const modOf = (event: string) => /^[a-z0-9]+/.exec(event)?.[0] ?? "daemon";
export const keyOf = (family: string, name: unknown) =>
	typeof name === "string" && name ? `${family}.${name}` : undefined;

/**
 * The logger's engine (docs/OBSERVABILITY.md section 3): validates a call against the registry, scrubs the row, and appends it to `obs.db` with one
 * prepared INSERT. It never throws and never waits:
 *   - an unknown event or field is dropped and counted (`rejected`);
 *   - a hit by the scrubber's rules is dropped and counted (`redacted`, which must read zero);
 *   - a write that fails (the lock is held, the disk is full) is counted (`failed`), the row waits in a bounded buffer for the next call to retry, and the
 *     first complaint in a minute is printed to stderr;
 *   - an `obs.db` that cannot be opened at all (a newer build wrote it, the directory is unwritable) makes every call a no-op, and the old `events` table keeps
 *     being written through `mirror`.
 *
 * `mirror` is the dual-write: the caller's own line, as the old `events` table has always held it, with the same `source_key` as the new row.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { OpenOptions } from "../sqlite-store.ts";
import type { LogEvent } from "../store.ts";
import { Transitions } from "./change.ts";
import { type ObsDb, openObsDb } from "./db.ts";
import { errClass, type FieldValue, own } from "./fields.ts";
import { canonical, EVENTS, type EventSpec, FAMILIES, type Level } from "./registry.ts";
import { type Columns, type Ctx, columnsOf, projectLegacy, projectTyped } from "./row.ts";
import { hit, RULES, type Rule, scrub } from "./scrub.ts";

type Mirror = (line: LogEvent, key?: string) => void;
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
/** What happened to a row: it is stored, it was already there (`source_key`), it waits for a retry, or it is gone. */
export type Outcome = "stored" | "ignored" | "buffered" | "dropped";

type Row = [
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
type Call = {
	level: Level;
	name: string;
	data: Record<string, FieldValue>;
	cols: Columns;
	mod: string;
	t: string;
	sourceKey?: string;
};
/** A column that code (never data) sets: the host, the module. Lowercase letters, digits and dashes, short. */
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A derived row's key: only the shapes the ledger's own ids make (src/core/obs/ledger.ts). A later piece that derives rows from something else adds its shape here. */
const SOURCE_KEY = /^(?:decision:\d{1,12}|item:Q-[a-z0-9]{4,16}:(?:asked|answered)|hold:[0-9a-f]{8}:closed)$/;
const BUFFER = 500;
const RETRY_MS = 250;
const FLUSH_MS = 5000;
const COMPLAIN_MS = 60_000;
const INSERT =
	"INSERT OR IGNORE INTO events (t, level, host, run, mod, event, corr, delivery, thread, source_key, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const COUNT =
	"INSERT INTO obs_counter (host, name, n) VALUES (?, ?, ?) ON CONFLICT (host, name) DO UPDATE SET n = n + excluded.n";

/** The name of this machine as a column value: lowercase letters, digits and dashes. */
export function hostName(env: NodeJS.ProcessEnv = process.env): string {
	const raw = (env.CHAMBERLAIN_HOST || hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	return raw.replace(/^-+|-+$/g, "").slice(0, 32) || "local";
}

/** The module a legacy event belongs to when its caller bound none: its name up to the first dot or dash. */
const modOf = (event: string) => /^[a-z0-9]+/.exec(event)?.[0] ?? "daemon";
const keyOf = (family: string, name: unknown) => (typeof name === "string" && name ? `${family}.${name}` : undefined);

export class Obs {
	readonly host: string;
	readonly run: string;
	readonly counters: Counters = { rejected: 0, redacted: 0, failed: 0, dropped: 0 };
	/** Rows stored at each level by this process: the heartbeat's warn and error counts. */
	readonly levels: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0 };
	private db: ObsDb | undefined;
	private insert: ReturnType<ObsDb["query"]> | undefined;
	private readonly known = new Map<string, Set<string>>();
	private readonly transitions = new Transitions();
	private readonly buffer: Row[] = [];
	private readonly flushed: Counters = { rejected: 0, redacted: 0, failed: 0, dropped: 0 };
	private lastFlush = 0;
	private lastRetry = 0;
	private lastComplaint = -COMPLAIN_MS;
	private readonly registry: Readonly<Record<string, EventSpec>>;
	private readonly rules: readonly Rule[];
	private readonly now: () => number;

	constructor(private readonly o: ObsOptions) {
		this.host = o.host !== undefined && LABEL.test(o.host) ? o.host : hostName();
		this.run = o.run ?? randomBytes(6).toString("hex");
		this.registry = o.registry ?? EVENTS;
		this.rules = o.rules ?? RULES;
		this.now = o.now ?? Date.now;
		try {
			this.db = openObsDb(o.path, o.open);
			this.insert = this.db.query(INSERT);
		} catch (e) {
			this.complain(`could not open the telemetry database: ${String(e).slice(0, 160)}`);
		}
	}

	/** Names a `known` set's members (the server names, the receiver names): the only values a field of that set accepts. */
	allow(set: string, names: Iterable<string>): void {
		const s = this.known.get(set) ?? new Set<string>();
		for (const n of names) s.add(n);
		this.known.set(set, s);
	}

	/** The time of a call now, as the ISO string both tables hold. */
	stamp(): string {
		return new Date(this.now()).toISOString();
	}

	// ---- the two ways in -----------------------------------------------------------------------------

	/** Records an event a typed caller names. Never throws. */
	record(level: Level, name: string, fields: Record<string, unknown>, ctx: Ctx, opts: CallOptions = {}): Outcome {
		try {
			const spec = own(this.registry, name);
			if (!spec || (opts.sourceKey !== undefined && !SOURCE_KEY.test(opts.sourceKey))) return this.reject();
			const t = opts.t ?? new Date(this.now()).toISOString();
			const p = projectTyped(spec, fields, this.known);
			const { cols, rejected } = columnsOf({}, ctx);
			this.counters.rejected += p.rejected + rejected;
			const call: Call = {
				level,
				name,
				data: p.data,
				cols,
				mod: this.modFor(ctx, name),
				t,
				sourceKey: opts.sourceKey,
			};
			const line = () => ({
				t,
				src: call.mod,
				event: spec.legacy ?? name,
				...p.data,
				...(cols.corr ? { corr: cols.corr } : {}),
			});
			return this.commit(call, opts.noMirror ? undefined : line);
		} catch (e) {
			return this.failure(e);
		}
	}

	/**
	 * Records what an existing call site said, by its old event name, and mirrors `line` (what the old table has always held) unless the event is a
	 * repeat of an outage that is already recorded. The mirror happens even when `obs.db` is unusable.
	 */
	legacy(event: string, data: Record<string, unknown>, ctx: Ctx, line: LogEvent): void {
		let keep = true;
		try {
			const name = canonical(event);
			const spec = name ? own(this.registry, name) : undefined;
			if (name && spec) keep = this.legacyRow(name, spec, data, ctx, line.t);
			else this.counters.rejected++;
		} catch (e) {
			this.failure(e);
		}
		if (keep) this.mirrorLine(line);
	}

	/**
	 * A state change for `key` (`<family>.<name>`): stored when the state differs from the last one seen, with the count the repeats of the last
	 * state suppressed in `suppressed`; a first sighting is stored too. Returns whether it stored. Never throws.
	 */
	change(key: string, state: string, fields: Record<string, unknown>, ctx: Ctx): boolean {
		try {
			const dot = key.indexOf(".");
			const fam = own(FAMILIES, key.slice(0, dot));
			if (!fam?.states.includes(state) || dot < 1) {
				this.reject();
				return false;
			}
			const step = this.transitions.see(key, state);
			if (!step.write) return false;
			const typed = { ...fields, name: key.slice(dot + 1), state, suppressed: step.suppressed };
			this.record(state === fam.states[0] ? "info" : "warn", fam.event, typed, ctx);
			return true;
		} catch (e) {
			this.failure(e);
			return false;
		}
	}

	private legacyRow(name: string, spec: EventSpec, data: Record<string, unknown>, ctx: Ctx, t: string): boolean {
		const edge = spec.enters ?? spec.leaves;
		const key = edge ? keyOf(edge.family, data[edge.name]) : undefined;
		if (edge && key && spec.enters) return this.outage(key, edge.state, data, ctx, t);
		if (edge && key) this.recovery(key, edge.state, ctx, t);
		const p = projectLegacy(spec, data, this.known);
		const { cols, rejected } = columnsOf(data, ctx);
		this.counters.rejected += p.rejected + rejected;
		this.commit({ level: spec.level, name, data: p.data, cols, mod: this.modFor(ctx, name), t });
		return true;
	}

	/** A failure that enters a state: one row for the outage (the first), none for the repeats. Returns whether the legacy line is kept. */
	private outage(key: string, state: string, data: Record<string, unknown>, ctx: Ctx, t: string): boolean {
		const step = this.transitions.see(key, state);
		if (!step.write) return false;
		const err = data.error === undefined ? {} : { err: errClass(data.error) };
		const fam = own(FAMILIES, key.slice(0, key.indexOf(".")));
		if (fam)
			this.record(
				"warn",
				fam.event,
				{ ...err, name: key.slice(key.indexOf(".") + 1), state, suppressed: step.suppressed },
				ctx,
				{ t, noMirror: true },
			);
		return true;
	}

	/** An event that leaves a state: a row only when a failure was recorded for the key. */
	private recovery(key: string, state: string, ctx: Ctx, t: string): void {
		const step = this.transitions.recover(key, state);
		const fam = own(FAMILIES, key.slice(0, key.indexOf(".")));
		if (step.write && fam)
			this.record(
				"info",
				fam.event,
				{ name: key.slice(key.indexOf(".") + 1), state, suppressed: step.suppressed },
				ctx,
				{ t, noMirror: true },
			);
	}

	/** The module column: the caller's when it is a label, else the event's own prefix (a module name that is not one is counted). */
	private modFor(ctx: Ctx, name: string): string {
		if (ctx.mod === undefined) return modOf(name);
		if (LABEL.test(ctx.mod)) return ctx.mod;
		this.counters.rejected++;
		return modOf(name);
	}

	// ---- from a call to a row -----------------------------------------------------------------------

	private commit(call: Call, line?: () => LogEvent): Outcome {
		this.tick();
		if (call.level === "debug" && !(this.o.debug ?? process.env.CHAMBERLAIN_LOG === "debug")) return "dropped";
		const row = this.toRow(call);
		if (line) this.mirrorLine(line(), call.sourceKey);
		return row ? this.store(row) : "dropped";
	}

	/** The row, after the scrubber: whatever it matches is dropped from `data` and counted, and a column it matches drops the whole row. */
	private toRow(c: Call): Row | undefined {
		const { clean, hits } = scrub(c.data, this.rules);
		const columns: [string, string | null | undefined][] = [
			["mod", c.mod],
			["event", c.name],
			["source_key", c.sourceKey],
			["thread", c.cols.thread],
			["corr", c.cols.corr],
			["delivery", c.cols.delivery],
		];
		const bad = columns.filter(([k, v]) => v && hit(k, v, this.rules));
		this.counters.redacted += hits.length + bad.length;
		if (bad.length) return undefined;
		return [
			c.t,
			c.level,
			this.host,
			this.run,
			c.mod,
			c.name,
			c.cols.corr,
			c.cols.delivery,
			c.cols.thread,
			c.sourceKey ?? null,
			JSON.stringify(clean),
		];
	}

	private mirrorLine(line: LogEvent, key?: string): void {
		try {
			this.o.mirror?.(line, key);
		} catch (e) {
			this.complain(`could not write the event log: ${String(e).slice(0, 160)}`);
		}
	}

	// ---- the database --------------------------------------------------------------------------------

	private store(row: Row): Outcome {
		const stmt = this.insert;
		if (!stmt) {
			this.counters.dropped++;
			return "dropped";
		}
		this.retry();
		try {
			const changes = stmt.run(...row).changes;
			this.levels[row[1]]++;
			return changes ? "stored" : "ignored";
		} catch (e) {
			this.failure(e);
			return this.hold(row);
		}
	}

	/** Keeps a row for the next call to retry, dropping the oldest when the buffer is full. */
	private hold(row: Row): Outcome {
		if (this.buffer.length >= BUFFER) {
			this.buffer.shift();
			this.counters.dropped++;
		}
		this.buffer.push(row);
		return "buffered";
	}

	private retry(): void {
		const stmt = this.insert;
		const t = this.now();
		if (!stmt || this.buffer.length === 0 || t - this.lastRetry < RETRY_MS) return;
		this.lastRetry = t;
		while (this.buffer[0]) {
			try {
				stmt.run(...this.buffer[0]);
				this.buffer.shift();
			} catch {
				return;
			}
		}
	}

	private reject(): Outcome {
		this.tick();
		this.counters.rejected++;
		return "dropped";
	}

	private failure(e: unknown): Outcome {
		this.counters.failed++;
		this.complain(`could not write the event log: ${String(e).slice(0, 160)}`);
		return "dropped";
	}

	private complain(message: string): void {
		const t = this.now();
		if (t - this.lastComplaint < COMPLAIN_MS) return;
		this.lastComplaint = t;
		(this.o.complain ?? ((m) => console.error(`chamberlain: ${m}`)))(message);
	}

	// ---- counters and the end -----------------------------------------------------------------------

	/** Adds the counters to the table when a few seconds have passed since the last time: a process that only ever rejects still reports. */
	private tick(): void {
		if (this.now() - this.lastFlush >= FLUSH_MS) this.flush();
	}

	/** Adds this process's counters to the table. Called every few seconds while it logs, and on close. */
	flush(): void {
		this.lastFlush = this.now();
		const db = this.db;
		if (!db) return;
		try {
			for (const k of Object.keys(this.counters) as (keyof Counters)[]) {
				const delta = this.counters[k] - this.flushed[k];
				if (delta <= 0) continue;
				db.query(COUNT).run(this.host, `log.${k}`, delta);
				this.flushed[k] = this.counters[k];
			}
		} catch {
			/* the counters stay in memory and go with the next flush */
		}
	}

	/** The counters of every process of this host, summed: what the report prints, and what `redacted` must read zero in. */
	totals(): Counters {
		this.flush();
		const out: Counters = { rejected: 0, redacted: 0, failed: 0, dropped: 0 };
		const rows = this.db?.query("SELECT name, n FROM obs_counter WHERE host = ?").all(this.host) as
			| { name: string; n: number }[]
			| undefined;
		for (const r of rows ?? []) {
			const k = r.name.replace(/^log\./, "") as keyof Counters;
			if (k in out) out[k] = r.n;
		}
		return out;
	}

	/** Copies the write-ahead log into the database, without waiting for anyone. Called from the daemon's hourly pass, never from a log call. */
	checkpoint(): void {
		try {
			this.db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
		} catch {
			/* a reader or writer is busy: the next pass tries again */
		}
	}

	/** The database, for the reconciler and the tests: undefined when it could not be opened or is closed. */
	get handle(): ObsDb | undefined {
		return this.db;
	}

	/** Retries what waits, flushes the counters and closes `obs.db`. Later calls are no-ops. */
	close(): void {
		this.lastRetry = Number.NEGATIVE_INFINITY;
		this.retry();
		this.flush();
		this.checkpoint();
		this.insert = undefined;
		try {
			this.db?.close();
		} catch {
			/* closed */
		}
		this.db = undefined;
	}
}

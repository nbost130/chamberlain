/** The telemetry writer, first layer: its settings, its database and the checks on a value a caller hands it. */
import { randomBytes } from "node:crypto";
import type { LogEvent } from "../store.ts";
import { Transitions } from "./change.ts";
import { type ObsDb, openObsDb } from "./db.ts";
import {
	COMPLAIN_MS,
	type Counters,
	hostName,
	INSERT,
	ISO,
	LABEL,
	modOf,
	type ObsOptions,
	type Row,
	RUN,
} from "./obs-spec.ts";
import { EVENTS } from "./registry-events.ts";
import type { EventSpec, Level } from "./registry-spec.ts";
import type { Ctx } from "./row.ts";
import { hit, RULES, type Rule } from "./scrub.ts";

export class ObsBase {
	readonly host: string;
	readonly run: string;
	readonly counters: Counters = { rejected: 0, redacted: 0, failed: 0, dropped: 0 };
	/** Rows stored at each level by this process: the heartbeat's warn and error counts. */
	readonly levels: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0 };
	protected db: ObsDb | undefined;
	protected insert: ReturnType<ObsDb["query"]> | undefined;
	protected readonly known = new Map<string, Set<string>>();
	protected readonly transitions = new Transitions();
	protected readonly buffer: Row[] = [];
	protected readonly flushed: Counters = { rejected: 0, redacted: 0, failed: 0, dropped: 0 };
	protected lastFlush = 0;
	protected lastRetry = 0;
	protected mirrorScheduled = false;
	protected readonly pendingMirror: [LogEvent, string | undefined][] = [];
	protected lastComplaint = -COMPLAIN_MS;
	protected readonly registry: Readonly<Record<string, EventSpec>>;
	protected readonly rules: readonly Rule[];
	protected readonly now: () => number;

	constructor(protected readonly o: ObsOptions) {
		this.rules = o.rules ?? RULES;
		const wanted = o.host !== undefined && LABEL.test(o.host) ? o.host : hostName();
		// The host is a column like any other: a name shaped like a credential is not stored (the rows say `local`), and it is counted.
		const bad = hit("host", wanted, this.rules) !== undefined;
		if (bad) this.counters.redacted++;
		this.host = bad ? "local" : wanted;
		this.run = o.run !== undefined && RUN.test(o.run) ? o.run : randomBytes(6).toString("hex");
		this.registry = o.registry ?? EVENTS;
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

	/** `t` when it is an ISO timestamp, else now (and the bad value is counted): no column takes what a caller hands it unchecked. */
	protected timeOf(t: string | undefined): string {
		if (t === undefined) return this.stamp();
		if (ISO.test(t)) return t;
		this.counters.rejected++;
		return this.stamp();
	}

	/** The time of a call now, as the ISO string both tables hold. */
	stamp(): string {
		return new Date(this.now()).toISOString();
	}

	// ---- the two ways in -----------------------------------------------------------------------------

	/** The module column: the caller's when it is a label, else the event's own prefix (a module name that is not one is counted). */
	protected modFor(ctx: Ctx, name: string): string {
		if (ctx.mod === undefined) return modOf(name);
		if (LABEL.test(ctx.mod)) return ctx.mod;
		this.counters.rejected++;
		return modOf(name);
	}

	// ---- from a call to a row -----------------------------------------------------------------------

	protected complain(message: string): void {
		const t = this.now();
		if (t - this.lastComplaint < COMPLAIN_MS) return;
		this.lastComplaint = t;
		(this.o.complain ?? ((m) => console.error(`chamberlain: ${m}`)))(message);
	}

	// ---- counters and the end -----------------------------------------------------------------------
}

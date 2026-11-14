/** The telemetry writer, second layer: turning a call into a row, storing it, mirroring it to the old table, and flushing the counters. */
import type { LogEvent } from "../store.ts";
import type { ObsDb } from "./db.ts";
import { ObsBase } from "./obs-base.ts";
import { BUFFER, type Call, COUNT, type Counters, FLUSH_MS, type Outcome, RETRY_MS, type Row } from "./obs-spec.ts";
import { hit, scrub } from "./scrub.ts";

export class ObsStore extends ObsBase {
	/** Adds the counters to the table when a few seconds have passed since the last time: a process that only ever rejects still reports. */
	protected tick(): void {
		if (this.now() - this.lastFlush >= FLUSH_MS) this.flush();
	}

	protected reject(): Outcome {
		this.tick();
		this.counters.rejected++;
		return "dropped";
	}

	protected failure(e: unknown): Outcome {
		this.counters.failed++;
		this.complain(`could not write the event log: ${String(e).slice(0, 160)}`);
		return "dropped";
	}

	protected commit(call: Call, line?: () => LogEvent): Outcome {
		this.tick();
		if (call.level === "debug" && !(this.o.debug ?? process.env.CHAMBERLAIN_LOG === "debug")) return "dropped";
		const row = this.toRow(call);
		if (line) this.mirrorLine(line(), call.sourceKey);
		return row ? this.store(row) : "dropped";
	}

	/** The row, after the scrubber: whatever it matches is dropped from `data` and counted, and a column it matches drops the whole row. */
	protected toRow(c: Call): Row | undefined {
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

	/**
	 * The dual write is off the caller's path: the call only queues the line, and one microtask later the queue is written to the old table in a single
	 * transaction that never waits on another process (`tryAppendMany`). A busy ledger leaves the lines queued (500 at most; the oldest is dropped and counted)
	 * and a timer tries again. `flushMirror` writes what is queued now: the store's own readers call it first, so a process always reads its own lines.
	 * The old table can trail by moments under contention and loses its queue in a crash; `obs.db` is the record.
	 */
	protected mirrorLine(line: LogEvent, key?: string): void {
		if (!this.o.mirror) return;
		if (this.pendingMirror.length >= BUFFER) {
			this.pendingMirror.shift();
			this.counters.dropped++;
		}
		this.pendingMirror.push([line, key]);
		if (this.mirrorScheduled) return;
		this.mirrorScheduled = true;
		queueMicrotask(() => this.flushMirror());
	}

	flushMirror(): void {
		this.mirrorScheduled = false;
		const mirror = this.o.mirror;
		if (!mirror || this.pendingMirror.length === 0) return;
		try {
			if (mirror(this.pendingMirror) === false) this.retryMirrorLater();
			else this.pendingMirror.length = 0;
		} catch (e) {
			this.pendingMirror.length = 0;
			this.complain(`could not write the event log: ${String(e).slice(0, 160)}`);
		}
	}

	protected retryMirrorLater(): void {
		if (this.mirrorScheduled) return;
		this.mirrorScheduled = true;
		setTimeout(() => this.flushMirror(), RETRY_MS).unref();
	}

	// ---- the database --------------------------------------------------------------------------------

	protected store(row: Row): Outcome {
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
	protected hold(row: Row): Outcome {
		if (this.buffer.length >= BUFFER) {
			this.buffer.shift();
			this.counters.dropped++;
		}
		this.buffer.push(row);
		return "buffered";
	}

	protected retry(): void {
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
		this.flushMirror();
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

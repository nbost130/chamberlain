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
import type { LogEvent } from "../store.ts";
import { errClass, own } from "./fields.ts";
import { type Call, keyOf, type Outcome, SOURCE_KEY, type Where } from "./obs-spec.ts";
import { ObsStore } from "./obs-store.ts";
import { canonical, FAMILIES } from "./registry.ts";
import type { EventSpec, Level } from "./registry-spec.ts";
import { type Ctx, columnsOf, projectLegacy, projectTyped } from "./row.ts";

export class Obs extends ObsStore {
	/** Records an event a typed caller names. Never throws. */
	record(level: Level, name: string, fields: Record<string, unknown>, at: Where): Outcome {
		const { ctx, opts = {} } = at;
		try {
			const spec = own(this.registry, name);
			if (!spec || (opts.sourceKey !== undefined && !SOURCE_KEY.test(opts.sourceKey))) return this.reject();
			const t = this.timeOf(opts.t);
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
			if (name && spec) keep = this.legacyRow(name, spec, data, { ctx, t: this.stamp() });
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
			this.record(state === fam.states[0] ? "info" : "warn", fam.event, typed, { ctx });
			return true;
		} catch (e) {
			this.failure(e);
			return false;
		}
	}

	protected legacyRow(
		name: string,
		spec: EventSpec,
		data: Record<string, unknown>,
		at: { ctx: Ctx; t: string },
	): boolean {
		const { ctx, t } = at;
		const edge = spec.enters ?? spec.leaves;
		const key = edge ? keyOf(edge.family, data[edge.name]) : undefined;
		if (edge && key && spec.enters) return this.outage(key, edge.state, data, at);
		if (edge && key) this.recovery(key, edge.state, ctx, t);
		const p = projectLegacy(spec, data, this.known);
		const { cols, rejected } = columnsOf(data, ctx);
		this.counters.rejected += p.rejected + rejected;
		this.commit({ level: spec.level, name, data: p.data, cols, mod: this.modFor(ctx, name), t });
		return true;
	}

	/** A failure that enters a state: one row for the outage (the first), none for the repeats. Returns whether the legacy line is kept. */
	protected outage(key: string, state: string, data: Record<string, unknown>, at: { ctx: Ctx; t: string }): boolean {
		const { ctx, t } = at;
		const step = this.transitions.see(key, state);
		if (!step.write) return false;
		const err = data.error === undefined ? {} : { err: errClass(data.error) };
		const fam = own(FAMILIES, key.slice(0, key.indexOf(".")));
		if (fam)
			this.record(
				"warn",
				fam.event,
				{ ...err, name: key.slice(key.indexOf(".") + 1), state, suppressed: step.suppressed },
				{ ctx, opts: { t, noMirror: true } },
			);
		return true;
	}

	/** An event that leaves a state: a row only when a failure was recorded for the key. */
	protected recovery(key: string, state: string, ctx: Ctx, t: string): void {
		const step = this.transitions.recover(key, state);
		const fam = own(FAMILIES, key.slice(0, key.indexOf(".")));
		if (step.write && fam)
			this.record(
				"info",
				fam.event,
				{ name: key.slice(key.indexOf(".") + 1), state, suppressed: step.suppressed },
				{ ctx, opts: { t, noMirror: true } },
			);
	}
}

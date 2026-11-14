/**
 * The logger every module uses (docs/OBSERVABILITY.md section 3):
 *
 *   const log = obs.child({ mod: "relay", thread, corr });         // bind once per wake
 *   log.info("wake.delivered", { http: 202, attempt: 1 });         // fields typed by the registry
 *   log.change("server.mac", "down", { err: errClass(e) });        // writes on a transition, plus a suppressed count
 *   log.warn / log.error / log.debug                                // debug is not stored unless CHAMBERLAIN_LOG=debug
 *
 * The same object is also the old call: `log("delivered", { deliveryId, error })`, which every existing call site still makes. It is read through
 * the registry (src/core/obs/registry.ts), so what it carries beyond the registry's typed fields stays in the old `events` table and never reaches `obs.db`.
 */
import type { LogEvent } from "../store.ts";
import type { CallOptions, Obs } from "./obs.ts";
import type { Ctx } from "./row.ts";

type Fields = Record<string, unknown>;
type Emit = (event: string, fields?: Fields, opts?: CallOptions) => void;

/** What a call is bound to: the module, the thread (a UUID), the correlation id, and the raw delivery id (stored as its digest). */
export type Binding = Ctx;
export type Logger = ((event: string, data?: Fields) => void) & {
	info: Emit;
	warn: Emit;
	error: Emit;
	debug: Emit;
	change(key: string, state: string, fields?: Fields): void;
	child(binding: Binding): Logger;
	readonly obs: Obs;
};

/** A logger bound to `binding`. `base` is added to every old-style line, such as `{ src: "queue-web" }`. */
export function makeLogger(obs: Obs, binding: Binding = {}, base: Record<string, unknown> = {}): Logger {
	const call = ((event: string, data: Fields = {}) => {
		obs.legacy(event, data, binding, { t: obs.stamp(), ...base, event, ...data } as LogEvent);
	}) as Logger;
	const at =
		(level: "info" | "warn" | "error" | "debug"): Emit =>
		(event, fields = {}, opts) => {
			obs.record(level, event, fields, binding, opts);
		};
	Object.assign(call, {
		info: at("info"),
		warn: at("warn"),
		error: at("error"),
		debug: at("debug"),
		change: (key: string, state: string, fields: Fields = {}) => {
			obs.change(key, state, fields, binding);
		},
		child: (more: Binding) => makeLogger(obs, { ...binding, ...more }, base),
		obs,
	});
	return call;
}

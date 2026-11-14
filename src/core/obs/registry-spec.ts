/** The shapes the event registry is written in: a field, a level, an event and the helpers that build them. */
import { ERR_TYPE, type FieldType, T } from "./fields.ts";

/** How an old value becomes a field's: `len` is an array's length, `err` is `errClass`, `corrs` is each delivery id as its digest. */
type Via = "len" | "err" | "corrs";
export type FieldSpec = { type: FieldType; from?: string; via?: Via };
export type Level = "debug" | "info" | "warn" | "error";
/**
 * A transition event: the first sighting of `state` for `key` (`<family>.<name>`) is stored, repeats are counted into `suppressed`, and a
 * change of state is stored with the count of what it suppressed. `change` says which legacy event enters a state, `recovers` which leaves it.
 */
type ChangeSpec = { family: string; state: string; name: string };
export type EventSpec = {
	level: Level;
	legacy?: string;
	fields: Record<string, FieldSpec>;
	enters?: ChangeSpec;
	leaves?: ChangeSpec;
};

export const f = (type: FieldType, from?: string, via?: Via): FieldSpec => ({
	type,
	...(from ? { from } : {}),
	...(via ? { via } : {}),
});
export const int = (from?: string) => f(T.int, from);
export const ms = (from?: string) => f(T.ms, from);
export const bool = (from?: string) => f(T.bool, from);
export const len = (from: string) => f(T.int, from, "len");
export const corrs = (from: string) => f(T.list(T.hex12, 200), from, "corrs");
export const SRV = f(T.known("server"), "server");
export const RCV = f(T.known("receiver"), "receiver");
export const ERR = f(ERR_TYPE, "error", "err");
export const ITEM = f(T.item, "item");
export const ITEM_FROM_ID = f(T.item, "id");
export const HTTP = int("http");
export const ATTEMPT = int("attempt");
export const KIND = f(
	T.enm(
		"needs_input",
		"failed",
		"turn_ended",
		"compact",
		"sweep",
		"digest",
		"alert",
		"question",
		"pending",
		"idle",
		"report",
		"rights",
		"preamble",
		"stale",
		"card",
		"window",
		"thread",
		"only-you",
		"product",
		"ruling",
		"idea",
	),
	"kind",
);
export const FAILURE = f(
	T.enm(
		"stream_closed",
		"rate_limit",
		"capacity",
		"provider_turn_failed",
		"oom",
		"auth",
		"cloudflare",
		"safety",
		"quota",
		"workspace",
		"interrupted",
		"unknown",
	),
	"kind",
);
export const ORIGIN = f(T.enm("page", "batch", "card", "daemon", "reconciler"), "by");
export const WAKE_ACTION = f(T.enm("none", "findings", "full"), "wake");

export const e = (
	level: Level,
	fields: Record<string, FieldSpec> = {},
	legacy?: string,
	change?: Pick<EventSpec, "enters" | "leaves">,
): EventSpec => ({
	level,
	...(legacy ? { legacy } : {}),
	fields,
	...change,
});

/** Failures of the daemon's own housekeeping: one shape, one class. */
export const failure = (legacy?: string) => e("warn", { err: ERR }, legacy);
/** A server problem: which server and what class of error. */
export const serverFailure = (level: Level = "warn") => e(level, { server: SRV, err: ERR });

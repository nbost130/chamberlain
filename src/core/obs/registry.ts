/**
 * The event registry (docs/OBSERVABILITY.md section 3): every event `obs.db` stores, with the fields it may carry and each field's opaque type.
 * An event or field that is not here is dropped and counted (`log.rejected`), never stored and never thrown.
 *
 * Two kinds of caller meet it:
 *   - typed code calls `log.info("wake.delivered", { http: 202 })`: the field names are the registry's, and an extra one is rejected;
 *   - the existing call sites call `log("delivered", { deliveryId, error: String(e), title })`: the registry's `legacy` name finds the event, and
 *     each field names the old key it is read from (`from`) and how (`via`). Whatever the registry does not name is left behind, which is
 *     exactly how a title, a path or an error message never reach `obs.db`. (The old `events` table keeps the old line until release C.)
 *
 * Four keys are not fields but columns, lifted by obs.ts: the thread (`threadId`), the delivery (`deliveryId`, kept as its digest), the
 * correlation id and the question item. Every field name must stay clear of the scrubber's key rule (no `token`, `secret`...): a test checks.
 */
import { EVENTS } from "./registry-events.ts";

/** The names of the registered events: what a typed call may name. */
export type EventName = keyof typeof EVENTS;

/** Transition families (`log.change("server.mac", "down")`): the event a state change is stored as, its name's set and its states. */
export const FAMILIES: Readonly<Record<string, { event: string; set: string; states: readonly string[] }>> = {
	server: { event: "server.state", set: "server", states: ["up", "down"] },
};

/** The registry name of a legacy event name (the name the existing call sites use), or the name itself. */
const BY_LEGACY = new Map<string, string>(
	Object.entries(EVENTS).flatMap(([name, spec]) => (spec.legacy ? [[spec.legacy, name] as [string, string]] : [])),
);
export const canonical = (event: string): string | undefined =>
	Object.hasOwn(EVENTS, event) ? event : BY_LEGACY.get(event);

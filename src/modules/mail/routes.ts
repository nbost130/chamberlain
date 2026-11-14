/**
 * `mail.routes`: where a picked newsletter highlight goes (docs/EMAIL-TRIAGE.md, sections 2 and 6). A route is data, so a new one is added by
 * writing it into config.json, with no code. Three kinds:
 *
 *   file     Markdown appended to a file (an Obsidian Reading list)
 *   command  the operator's own program, given the highlight as JSON on stdin (Readwise Reader, a to-do app); it may fetch, and runs only
 *            on a tap, so it is outside the module's no-fetch guarantee
 *   steward  a task for the Steward
 *
 * This file only says what a route is. Carrying one out is B7 (#40).
 */
import { isArgv, object, required } from "../../core/config-fields.ts";

export type Route =
	| { id: string; label: string; kind: "steward" }
	| { id: string; label: string; kind: "file"; file: string }
	| { id: string; label: string; kind: "command"; command: string[] };

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const COMMON = ["id", "label", "kind"];
const KINDS = ["steward", "file", "command"];

function parseRoute(raw: unknown, at: string): Route {
	const kind = (raw as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !KINDS.includes(kind)) throw Error(`${at}: kind must be one of ${KINDS.join(", ")}`);
	const extra = kind === "file" ? ["file"] : kind === "command" ? ["command"] : [];
	const o = object(raw, at, [...COMMON, ...extra]);
	const id = required(o, "id", at);
	if (!ID.test(id))
		throw Error(`${at}: id must be lowercase letters, digits and "-", starting with a letter (at most 32)`);
	const label = required(o, "label", at);
	if (label.length > 60) throw Error(`${at}: label must be at most 60 characters`);
	if (kind === "steward") return { id, label, kind };
	if (kind === "file") return { id, label, kind, file: required(o, "file", at) };
	if (!isArgv(o.command)) throw Error(`${at}: command must be ["program", "arg", ...]`);
	return { id, label, kind: "command", command: o.command };
}

/** Pure: the routes, checked: each valid, ids different. Left out means `d`; an empty list is refused, because a card must offer somewhere to go. */
export function parseRoutes(raw: unknown, where: string, d: Route[]): Route[] {
	if (raw === undefined) return structuredClone(d);
	if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw Error(`${where}: expected a list of 1 to 20 routes`);
	const routes = raw.map((r, i) => parseRoute(r, `${where}[${i}]`));
	const ids = routes.map((r) => r.id);
	if (new Set(ids).size !== ids.length) throw Error(`${where}: each route needs its own id`);
	return routes;
}

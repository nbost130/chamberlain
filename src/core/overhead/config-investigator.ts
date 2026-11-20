/** The `overhead.investigator` sub-section: the thread opened on a crossing. Its defaults are given by the caller (config.ts owns them). */
import { bool, num, object, str } from "../config/config-fields.ts";
import { threadModel } from "../llm/selection.ts";
import type { OverheadConfig } from "./config.ts";
import { hours, type Obj, plain } from "./config-names.ts";

type Investigator = OverheadConfig["investigator"];

/** The keys of a T3 thread selection, as `models.<role>` takes them. */
const MODEL_KEYS = ["adapter", "server", "instanceId", "model", "options"];
const KEYS = ["enabled", "model", "projectId", "title", "cooldownHours", "maxOpen", "ttlHours", "instructions"];

/** A T3 project id: a UUID, or `mcp:` and a UUID for a project an agent created. It goes only into a T3 command, never a query. */
function projectId(o: Obj, where: string): string {
	const v = str(o, "projectId", where, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,100}$/.test(v)) throw Error(`${where}: projectId must be a T3 project id`);
	return v;
}

export function parseInvestigator(raw: unknown, where: string, d: Investigator): Investigator {
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, where, KEYS);
	const model =
		o.model === undefined || o.model === null
			? null
			: threadModel(object(o.model, `${where}.model`, MODEL_KEYS), `${where}.model`);
	return {
		enabled: bool(o, "enabled", where, d.enabled),
		model,
		projectId: o.projectId === undefined || o.projectId === null ? null : projectId(o, where),
		title: plain(o, "title", where, d.title),
		cooldownHours: num(o, "cooldownHours", where, { d: d.cooldownHours, whole: false, zeroOk: true }),
		maxOpen: num(o, "maxOpen", where, { d: d.maxOpen, whole: true }),
		ttlHours: hours(o, "ttlHours", where, d.ttlHours),
		instructions: o.instructions === undefined ? d.instructions : str(o, "instructions", where, ""),
	};
}

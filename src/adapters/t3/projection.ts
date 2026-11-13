/**
 * The shape the T3 adapter expects of a thread projection (`orchestration.getThreadProjection`). Every read of one goes
 * through `checkProjection`: an answer in any other shape throws, so it is a failed read and never an empty thread.
 */
export type Projection = { turnItems: any[]; runs?: any[]; subagents?: { status?: string }[] };
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure: a projection in the shape the reads expect (an object whose `turnItems` is a list of objects), or a throw naming what is wrong. */
export function checkProjection(p: unknown): Projection {
	if (!isObject(p)) throw Error("malformed projection: not an object");
	if (!Array.isArray(p.turnItems)) throw Error("malformed projection: turnItems is not a list");
	if (!p.turnItems.every(isObject)) throw Error("malformed projection: a turn item is not an object");
	for (const k of ["runs", "subagents"] as const) if (p[k] !== undefined && !Array.isArray(p[k])) throw Error(`malformed projection: ${k} is not a list`);
	return p as Projection;
}

/** The pieces of the read-only LifeOS statements the overhead queries share. Built from numbers and from names config.ts has restricted to plain characters, so nothing a config says can change a statement's shape. */
import type { OverheadConfig } from "./config.ts";

/** A list of names as SQL string literals, quotes doubled. */
export const quoted = (names: readonly string[]) => names.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");

/** `o.occurred_at` inside [from, to), in epoch milliseconds. */
export const spanSql = (from: number, to: number): string =>
	`o.occurred_at >= to_timestamp(${Math.floor(from / 1000)}) AND o.occurred_at < to_timestamp(${Math.floor(to / 1000)})`;

/**
 * Whether session `s` is an experiment (`excludeProjects`, `excludeLabels`), as a SQL condition; empty when nothing is excluded. A request with
 * no session row (`s` null) is not one: `coalesce(..., false)` keeps it.
 */
export function excludedSql(cfg: Pick<OverheadConfig, "excludeProjects" | "excludeLabels">): string {
	return [
		...(cfg.excludeProjects.length ? [`coalesce(s.project IN (${quoted(cfg.excludeProjects)}), false)`] : []),
		...(cfg.excludeLabels.length ? [`coalesce(s.labels && ARRAY[${quoted(cfg.excludeLabels)}]::text[], false)`] : []),
	].join(" OR ");
}

/** Pure router: first matching rule for a critical event, else the default. */
import type { DeskEvent } from "./alert-desk-config.ts";
import type { Outcome, Right, TriageRule } from "./alert-triage-config.ts";

export type RouteHit = { id: string; outcome: Outcome; right?: Right };

function fieldMatch(pattern: string | undefined, value: string): boolean {
	if (pattern === undefined) return true;
	if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
	return pattern === value;
}

function matchRule(rules: TriageRule[], e: DeskEvent): RouteHit | undefined {
	for (const r of rules) {
		if (!fieldMatch(r.match.source, e.source)) continue;
		if (!fieldMatch(r.match.family, e.family)) continue;
		return { id: r.id, outcome: r.outcome, ...(r.right ? { right: r.right } : {}) };
	}
	return undefined;
}

/** Criticals only. Non-criticals are never routed here. */
export function routeCritical(rules: TriageRule[], e: DeskEvent): RouteHit {
	return matchRule(rules, e) ?? { id: "default-critical", outcome: "steward-task" };
}

/**
 * The investigator's brief: what crossed, the numbers and their trend, the wakes that did nothing (grouped by kind, with examples) and the
 * wakes that cost the most. From it the investigator finds the cause in code and opens a fix PR. The brief is built from numbers and keys only:
 * no wake text, transcript text or card title is in it, so it carries nothing a secret could be in. The investigator reads a wake's text
 * itself, from the Steward's transcript, by the delivery id it is given. Nothing in it is specific to an operator: their own rules go in
 * `overhead.investigator.instructions`, appended at the end.
 */
import { isWake } from "../steward/steward-tokens.ts";
import type { WakeUsage } from "../store/store-records.ts";
import type { OverheadReport } from "./collect.ts";
import { formatOverhead } from "./format.ts";
import { type CacheWrite, type Price, type TokenCounts, tokensUsd } from "./prices.ts";

const GROUPS = 6;
const EXAMPLES = 3;
const TOP_COST = 10;

type Example = { at: string; key: string; cost: number };
type Group = { kind: string; count: number; cost: number; examples: Example[] };
type Weight = (r: WakeUsage) => number;

const keyOf = (r: WakeUsage) => r.deliveryId ?? r.wakeKey;

/** Pure: the no-op wakes of the window grouped by kind, the biggest group first, each with its dearest wakes as examples. */
function noopGroups(rows: readonly WakeUsage[], weight: Weight): Group[] {
	const by = new Map<string, Group>();
	for (const r of rows) {
		if (!isWake(r.kind) || r.toolCalls !== 0) continue;
		const g = by.get(r.kind) ?? { kind: r.kind, count: 0, cost: 0, examples: [] };
		const cost = weight(r);
		g.count++;
		g.cost += cost;
		g.examples.push({ at: new Date(r.startedAt).toISOString(), key: keyOf(r), cost });
		by.set(r.kind, g);
	}
	return [...by.values()]
		.map((g) => ({ ...g, examples: g.examples.sort((a, b) => b.cost - a.cost).slice(0, EXAMPLES) }))
		.sort((a, b) => b.count - a.count)
		.slice(0, GROUPS);
}

/** Pure: the dearest turns of the window, wakes or not. */
function topCost(rows: readonly WakeUsage[], weight: Weight): (Example & { kind: string; tools?: number })[] {
	return rows
		.map((r) => ({
			kind: r.kind,
			at: new Date(r.startedAt).toISOString(),
			key: keyOf(r),
			cost: weight(r),
			...(r.toolCalls !== undefined ? { tools: r.toolCalls } : {}),
		}))
		.sort((a, b) => b.cost - a.cost)
		.slice(0, TOP_COST);
}

export type BriefCommands = { note: string; close: string; overhead: string };

/** What a row is ranked and shown by: dollars when the Steward has a price, else its total tokens. */
function costOf(price: Price | undefined, cacheWrite: CacheWrite) {
	const total = (r: TokenCounts) =>
		r.inputTokens + r.cacheReadInputTokens + r.cacheCreationInputTokens + r.outputTokens;
	const weight: Weight = (r) => (price ? tokensUsd(r, price, cacheWrite) : total(r));
	const show = (n: number) => (price ? `$${n.toFixed(2)}` : `${Math.round(n / 1000)}k tokens`);
	return { weight, show };
}

/** The brief. `rows` are the Steward's usage rows of the window; `extra` is the operator's own text (`overhead.investigator.instructions`). */
export function investigatorBrief(a: {
	id: string;
	report: OverheadReport;
	rows: readonly WakeUsage[];
	price?: Price;
	cacheWrite: CacheWrite;
	commands: BriefCommands;
	extra?: string;
}): string {
	const { weight, show } = costOf(a.price, a.cacheWrite);
	const groups = noopGroups(a.rows, weight);
	const lines = [
		`Overhead investigation ${a.id}`,
		"",
		"Chamberlain measured its own overhead and a limit was crossed. Your job: find the cause IN CODE (name file:line), and open a draft fix PR.",
		"Do not deploy, restart a service or edit live configuration or state; deploying is the operator's call.",
		"",
		"CROSSED",
		...a.report.crossings.map((c) => `- ${c.detail}`),
		"",
		`THE NUMBERS (the same output as \`${a.commands.overhead}\`)`,
		formatOverhead(a.report),
		"",
		"NO-OP WAKES BY KIND (wakes that made no tool call; example keys are delivery ids, readable in the Steward's transcript)",
		...(groups.length
			? groups.flatMap((g) => [
					`- ${g.kind}: ${g.count} wakes, ${show(g.cost)}`,
					...g.examples.map((e) => `    ${e.at}  ${e.key}  ${show(e.cost)}`),
				])
			: ["- none in the window"]),
		"",
		`DEAREST TURNS (top ${TOP_COST} by ${a.price ? "priced tokens" : "tokens"})`,
		...topCost(a.rows, weight).map(
			(e) => `- ${e.at}  ${e.kind}  ${e.key}  ${show(e.cost)}${e.tools === undefined ? "" : `  ${e.tools} tool calls`}`,
		),
		"",
		"HOW TO WORK",
		"- Work on a branch from the repository's main branch, in a worktree or clone of your own. Never edit, stage, stash or switch a checkout someone else is working in.",
		"- Run the repository's tests and lint before you push. One branch, one draft PR, conventional commits.",
		`- When you finish, report to the Steward: \`${a.commands.note} --from "Overhead investigator" '<the cause (file:line) and the PR url>'\`, then close this investigation: \`${a.commands.close} ${a.id}\`.`,
		"- If you find no code cause (the spend is real work), say that in the note instead of inventing a fix, and close the investigation the same way.",
		...(a.extra ? ["", a.extra] : []),
	];
	return lines.join("\n");
}

import type { GhRead } from "../decide/hold-lookup.ts";
import type { OverheadConfig } from "../overhead/config.ts";
import { mergedPrs } from "../overhead/merged-prs.ts";
import { countedPrs } from "../overhead/metrics.ts";
import { countCards } from "./cards.ts";
import type { DistillLedger, StewardPeriod } from "./ledger.ts";
import type { Span } from "./window.ts";

const DEFINITION_VERSION = 1;
type Github = OverheadConfig["github"];
type PrCount = { mergedPrs: number | null; prStatus: "ok" | "unavailable" | "not configured" };
type ChatCount = { chatRedirections?: number; chatStatus: "ok" | "unavailable" | "off" };
type Ratios = { escalationsPerPr?: number; correctionsPerPr?: number };
type CardStats = ReturnType<typeof countCards>;
export type DistillReport = CardStats["counts"] &
	PrCount &
	ChatCount &
	Ratios &
	Span & {
		week?: string;
		timezone: string;
		definitionVersion: number;
		correctionsByRuling: Record<string, number>;
	};

/** The one repository scope that cards and merged PRs are both held to. */
function scopeOf(github: Github): (repo: string) => boolean {
	const lower = (values: string[]) => new Set(values.map((value) => value.toLowerCase()));
	const [owners, repos, excluded] = [lower(github.owners), lower(github.repos), lower(github.excludeRepos)];
	return (repo) => !excluded.has(repo) && (repos.has(repo) || owners.has(repo.split("/")[0] ?? ""));
}

/** With nothing in scope and some cards unplaced, zero would be a guess. With every card placed, zero is the count. */
function ratios({ counts }: CardStats, prs: number): Ratios {
	const { scopedEscalations, scopedCorrections, unplaced } = counts;
	if (!prs || (!scopedEscalations && !scopedCorrections && unplaced)) return {};
	return { escalationsPerPr: scopedEscalations / prs, correctionsPerPr: scopedCorrections / prs };
}

async function prStats(gh: GhRead, github: Github, span: Span, cards: CardStats): Promise<PrCount & Ratios> {
	if (!github.owners.length && !github.repos.length) return { mergedPrs: null, prStatus: "not configured" };
	try {
		const rows = await mergedPrs(gh, github, span.from, span.to);
		const prs = countedPrs(
			rows.map((p) => ({ ...p, repo: p.repo.toLowerCase() })),
			span,
			{ ...github, countRollups: false },
		);
		const inScope = scopeOf(github);
		if (!prs.every((pr) => inScope(pr.split("#")[0] ?? ""))) return { mergedPrs: null, prStatus: "unavailable" };
		return { mergedPrs: prs.length, prStatus: "ok", ...ratios(cards, prs.length) };
	} catch {
		return { mergedPrs: null, prStatus: "unavailable" };
	}
}

export type ChatRead = (period: StewardPeriod) => Promise<number>;
async function chatStats(requested: boolean, periods: StewardPeriod[], read?: ChatRead): Promise<ChatCount> {
	if (!requested) return { chatStatus: "off" };
	if (!periods.length || !read) return { chatStatus: "unavailable" };
	try {
		const counts = await Promise.all(periods.map(read));
		const total = counts.reduce((sum, count) => sum + count, 0);
		if (!Number.isSafeInteger(total) || counts.some((count) => !Number.isSafeInteger(count) || count < 0))
			return { chatStatus: "unavailable" };
		return { chatRedirections: total, chatStatus: "ok" };
	} catch {
		return { chatStatus: "unavailable" };
	}
}

export async function distillReport(d: {
	ledger: DistillLedger;
	span: Span;
	week?: string;
	config: { timezone: string; chat: boolean };
	github: Github;
	gh: GhRead;
	readChat?: ChatRead;
}): Promise<DistillReport> {
	const cards = countCards(d.ledger, d.span, scopeOf(d.github));
	const [prs, chat] = await Promise.all([
		prStats(d.gh, d.github, d.span, cards),
		chatStats(d.config.chat, d.ledger.stewards, d.readChat),
	]);
	return {
		...d.span,
		...(d.week ? { week: d.week } : {}),
		timezone: d.config.timezone,
		definitionVersion: DEFINITION_VERSION,
		...cards.counts,
		correctionsByRuling: cards.correctionsByRuling,
		...prs,
		...chat,
	};
}

export function formatDistill(r: DistillReport): string {
	const from = new Date(r.from).toISOString();
	const to = new Date(r.to).toISOString();
	const lines = [
		`Distill ${from} → ${to} (${r.timezone}, definition ${r.definitionVersion})`,
		`Escalations: ${r.escalations}`,
		`Corrections: ${r.corrections} (${r.changedPicks} changed picks, ${r.directions} directions)`,
		`Accepted picks: ${r.acceptedPicks} · picks with notes: ${r.picksWithNote} · dismissals: ${r.dismissals}`,
		`Cards without a recommendation: ${r.noRecommendation} · snoozed cards: ${r.snoozes}`,
		`Unplaced cards: ${r.unplaced} · cards outside the PR scope: ${r.outOfScope}`,
		`Merged PRs: ${r.mergedPrs ?? r.prStatus}`,
		`Chat redirections (operator messages): ${r.chatRedirections ?? r.chatStatus}`,
	];
	if (r.escalationsPerPr !== undefined && r.correctionsPerPr !== undefined)
		lines.push(
			`Per merged PR: ${r.escalationsPerPr.toFixed(2)} escalations (${r.scopedEscalations} of ${r.escalations} counted) · ${r.correctionsPerPr.toFixed(2)} corrections (${r.scopedCorrections} of ${r.corrections} counted)`,
		);
	else if (r.mergedPrs) lines.push("Per merged PR: not shown, no card could be placed in the PR scope.");
	for (const [id, n] of Object.entries(r.correctionsByRuling)) lines.push(`${id}: ${n} corrections`);
	return lines.join("\n");
}

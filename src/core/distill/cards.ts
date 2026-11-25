import type { Answer } from "../items/questions.ts";
import { cleanRef, type Held, itemIdOf } from "../ops/afk-held.ts";
import { SAFE_REPO } from "../overhead/config-names.ts";
import type { DecisionRow, Item } from "../store/store.ts";
import type { DistillLedger } from "./ledger.ts";
import { inSpan, type Span } from "./window.ts";

const normalizeRepo = (v: unknown) => (typeof v === "string" && SAFE_REPO.test(v) ? v.toLowerCase() : undefined);
const timeOf = (v: unknown) => (typeof v === "string" ? Date.parse(v) : Number.NaN);

function holdRepos(holds: Item[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const { payload } of holds) {
		const item = itemIdOf(payload as Held);
		if (!item) continue;
		const ref = cleanRef(payload.ref);
		const repos = out.get(item) ?? new Set<string>();
		for (const link of [ref?.pr, ref?.issue]) {
			const repo = normalizeRepo(link?.split("#")[0]);
			if (repo) repos.add(repo);
		}
		out.set(item, repos);
	}
	return out;
}

function repoOf(card: Item, holds: Map<string, Set<string>>): string | undefined {
	if (card.payload.repo !== undefined) return normalizeRepo(card.payload.repo);
	const linked = holds.get(card.dedupKey);
	return linked?.size === 1 ? linked.values().next().value : undefined;
}

function citations(decisions: DecisionRow[], span: Span): Map<string, Set<string>> {
	const byThread = new Map<string, Set<string>>();
	for (const d of decisions) {
		if (!inSpan(timeOf(d.t), span)) continue;
		const ids = byThread.get(d.thread) ?? new Set<string>();
		for (const id of d.rulingIds ?? []) if (/^R\d+$/.test(id)) ids.add(id);
		byThread.set(d.thread, ids);
	}
	return byThread;
}

function threadAliases(cards: Item[]): Map<string, Set<string>> {
	const aliases = new Map<string, Set<string>>();
	for (const { payload } of cards) {
		const { thread, threadId, server } = payload;
		if (typeof thread !== "string" || typeof threadId !== "string" || typeof server !== "string") continue;
		const addresses = aliases.get(thread) ?? new Set<string>();
		addresses.add(JSON.stringify([server, threadId]));
		aliases.set(thread, addresses);
	}
	return aliases;
}

function rulingIds(card: Item, ids: Map<string, Set<string>>, aliases: Map<string, Set<string>>): Set<string> {
	const { thread, threadId } = card.payload;
	const exact = typeof threadId === "string" ? ids.get(threadId) : undefined;
	const legacy = typeof thread === "string" && (aliases.get(thread)?.size ?? 0) < 2 ? ids.get(thread) : undefined;
	return new Set([...(exact ?? []), ...(legacy ?? [])]);
}

const cardCounts = () => ({
	escalations: 0,
	corrections: 0,
	changedPicks: 0,
	directions: 0,
	acceptedPicks: 0,
	dismissals: 0,
	picksWithNote: 0,
	noRecommendation: 0,
	snoozes: 0,
	unplaced: 0,
});
type Counts = ReturnType<typeof cardCounts>;

function recommendation(card: Item): number | undefined {
	const { recommended, options } = card.payload;
	return typeof recommended === "number" &&
		Number.isInteger(recommended) &&
		Array.isArray(options) &&
		recommended >= 0 &&
		recommended < options.length
		? recommended
		: undefined;
}

/** Returns whether the answer was a correction. Dismissals and annotated picks take precedence over choice comparison. */
function countAnswer(counts: Counts, card: Item, answer: Answer, recommended: number | undefined): boolean {
	if (answer.kind === "dismissed") {
		counts.dismissals++;
		return false;
	}
	const { options } = card.payload;
	const pick =
		answer.choice >= 0 && Number.isInteger(answer.choice) && Array.isArray(options) && answer.choice < options.length;
	if (pick && answer.note?.trim()) counts.picksWithNote++;
	else if (recommended !== undefined) {
		if (answer.kind === "direction" && answer.choice === -1 && answer.note?.trim()) counts.directions++;
		else if (pick && answer.choice !== recommended) counts.changedPicks++;
		else {
			if (pick) counts.acceptedPicks++;
			return false;
		}
		counts.corrections++;
		return true;
	}
	return false;
}

function cardActivity(card: Item, span: Span, answer?: Answer, snoozed = false) {
	const asked = inSpan(card.firstSeen, span);
	const answered = answer && inSpan(timeOf(answer.t), span) ? answer : undefined;
	const snooze = snoozed || inSpan(timeOf(card.payload.snoozedAt), span);
	return asked || answered || snooze ? { asked, answered, snooze } : undefined;
}

/** Output is an aggregate projection: no question, note, decision or ruling text is returned. */
export function countCards(ledger: DistillLedger, span: Span) {
	const counts = cardCounts();
	const repos = new Set<string>();
	const correctionsByRuling = new Map<string, number>();
	const holds = holdRepos(ledger.holds);
	const ids = citations(ledger.decisions, span);
	const aliases = threadAliases(ledger.cards);
	const snoozed = new Set(ledger.snoozes.map((event) => event.id));
	const answers = new Map(ledger.claims.map((claim) => [claim.item, claim.answer as Answer | undefined]));
	for (const card of ledger.cards) {
		const activity = cardActivity(card, span, answers.get(card.dedupKey), snoozed.has(card.dedupKey));
		if (!activity) continue;
		const { asked, answered, snooze } = activity;
		const repo = repoOf(card, holds);
		if (repo) repos.add(repo);
		else counts.unplaced++;
		if (asked) counts.escalations++;
		if (snooze) counts.snoozes++;
		const recommended = recommendation(card);
		if (recommended === undefined) counts.noRecommendation++;
		if (answered && countAnswer(counts, card, answered, recommended))
			for (const id of rulingIds(card, ids, aliases))
				correctionsByRuling.set(id, (correctionsByRuling.get(id) ?? 0) + 1);
	}
	return { counts, repos, correctionsByRuling: Object.fromEntries([...correctionsByRuling].sort()) };
}

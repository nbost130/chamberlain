import type { parseIdeas } from "../config/ideas-config.ts";
import type { Store } from "../store/store.ts";
import { type Question, questionStates } from "./questions.ts";

type IdeaConfig = ReturnType<typeof parseIdeas>;

/** IDs identify a thread within its server. A legacy idea with no ID is matched by its stored title. */
function sameThread(a: Question, b: Question): boolean {
	return a.server === b.server && (a.threadId && b.threadId ? a.threadId === b.threadId : a.thread === b.thread);
}

/** Check under the same write lock as insertion. Closed and snoozed ideas still count on their filing day. */
export function ideaCapProblem(store: Store, q: Question, config: IdeaConfig, now: number): string | undefined {
	const day = new Intl.DateTimeFormat("en", {
		timeZone: config.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const today = day.format(now);
	const ideas = [...questionStates(store, now).values()].filter((item) => item.kind === "idea");
	const filedToday = ideas.filter((item) => {
		const filed = Date.parse(item.createdAt);
		return Number.isFinite(filed) && day.format(filed) === today;
	});
	if (filedToday.length >= config.dailyCap) return `daily idea cap (${config.dailyCap}, ${config.timeZone}) reached`;
	if (filedToday.filter((item) => sameThread(item, q)).length >= config.perThreadDailyCap)
		return `per-thread daily idea cap (${config.perThreadDailyCap}, ${config.timeZone}) reached`;
	if (ideas.filter((item) => item.status === "open").length >= config.openCap)
		return `open idea cap (${config.openCap}) reached`;
}

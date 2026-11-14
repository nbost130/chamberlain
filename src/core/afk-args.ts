/** The arguments of `afk.ts hold`: reading them, and the checks that refuse a hold on a settled question. */

import { usageExit } from "./afk.ts";
import { cleanRef, type Held, type HoldRef, ITEM_ID } from "./afk-held.ts";
import { principal, selfCommand } from "./config.ts";
import { getQuestion } from "./questions.ts";
import { findSettled, refusalLines } from "./settled.ts";
import type { Store } from "./store.ts";

export const HOLD_USAGE =
	'usage: afk.ts hold "<thread>" "<what waits>" ["<default taken>"] ["<threadId of an open card>"] --item <Q-id> [--not-settled "<why>"] [--pr <owner/repo#n>] [--issue <owner/repo#n>] [--branch <owner/repo:branch>] [--run <run id>] [--thread <threadId> --server <name>]';
const HOLD_FLAGS = ["--item", "--not-settled", "--pr", "--issue", "--branch", "--run", "--thread", "--server"];

/** The positional arguments of `hold` and its flags. A flag that is unknown or has no value exits with the usage. */
function parseHoldArgs(rest: string[]): { flags: Record<string, string>; pos: string[] } {
	const flags: Record<string, string> = {};
	const pos: string[] = [];
	const args = rest.values();
	for (const a of args) {
		if (!a.startsWith("--")) {
			pos.push(a);
			continue;
		}
		const value = args.next();
		if (!HOLD_FLAGS.includes(a) || value.done) usageExit(HOLD_USAGE);
		flags[a] = value.value;
	}
	return { flags, pos };
}

/** The --item of a hold. A hold with none exits 2: whatever waits on the principal goes on the decision queue first. */
export function requireItem(item: string | undefined): string {
	if (!item)
		usageExit(
			`afk.ts hold: refused, a hold needs --item <Q-id>. Anything that waits on ${principal()} goes on the decision queue first: ${selfCommand("ask")} '<json>' (add "urgent": false if it can wait), then hold it with the item ID it prints.`,
		);
	return item;
}

/** The open question a hold names. One that is not on the queue, or is already answered, exits 2. */
export function openQuestionOf(store: Store, item: string) {
	const queued = getQuestion(store, item);
	if (!queued)
		usageExit(
			`afk.ts hold: refused, ${item} is not on the decision queue. File the question with ask.ts first, then hold it with the item ID it prints.`,
		);
	// A hold on a question already answered waits on nothing: the answer is what the hold was for.
	if (queued.status === "dismissed")
		usageExit(`afk.ts hold: refused, ${item} was dismissed: nothing waits on ${principal()}.`);
	if (queued.status !== "open")
		usageExit(
			`afk.ts hold: refused, ${item} is already answered (${queued.answer ? `"${queued.answer.label}"` : "on its card"}). Act on the answer; nothing waits on ${principal()}.`,
		);
	return queued;
}

/** Refuses a hold that matches something already settled. Reasons the check could not read something are printed and do not refuse. */
export function refuseIfSettled(store: Store, q: Parameters<typeof findSettled>[1]) {
	const { matches, skipped } = findSettled(store, q);
	for (const k of skipped) console.error(`afk.ts hold: the settled check could not read ${k}`);
	if (matches.length)
		usageExit(
			refusalLines("afk.ts hold", matches, 'add --not-settled "<why this is a different question>"').join("\n"),
		);
}

/** What `hold` was given: its words, the flags, and the ref fields they make. */
type HoldArgs = {
	thread: string | undefined;
	what: string | undefined;
	taken: string | undefined;
	/** The positional threadId of an open card. */
	cardThread: string | undefined;
	item: string | undefined;
	server: string | undefined;
	notSettledFlag: string | undefined;
	raw: { pr?: string; issue?: string; branch?: string; runId?: string; threadId?: string };
	ref: HoldRef | undefined;
	/** How many ref fields were given, well formed or not. */
	given: number;
};

export function readHoldArgs(rest: string[]): HoldArgs {
	const { flags, pos } = parseHoldArgs(rest);
	const [thread, what, taken, cardThread] = pos;
	const raw = {
		pr: flags["--pr"],
		issue: flags["--issue"],
		branch: flags["--branch"],
		runId: flags["--run"],
		threadId: flags["--thread"],
	};
	return {
		thread,
		what,
		taken,
		cardThread,
		item: flags["--item"],
		server: flags["--server"],
		notSettledFlag: flags["--not-settled"],
		raw,
		ref: cleanRef(raw),
		given: Object.values(raw).filter((v) => v !== undefined).length,
	};
}

/** Whether the item, the refs and the server of a hold are well formed. A server needs a thread beside it. */
export function holdFieldsOk(h: HoldArgs): boolean {
	if (h.item !== undefined && !ITEM_ID.test(h.item)) return false;
	if (Object.keys(h.ref ?? {}).length !== h.given) return false;
	return h.server === undefined || (/^[A-Za-z0-9_.-]{1,40}$/.test(h.server) && Boolean(h.raw.threadId || h.cardThread));
}

/** The hold to write, from what it was given and the reason it may stand although something settled matches it. */
export function heldFrom(
	h: HoldArgs & { thread: string; what: string },
	item: string,
	why: string | undefined,
): Omit<Held, "t"> {
	return {
		thread: h.thread,
		what: h.what,
		...(h.taken ? { taken: h.taken } : {}),
		...(h.cardThread ? { threadId: h.cardThread } : {}),
		...(h.server ? { server: h.server } : {}),
		item,
		...(why ? { notSettled: why } : {}),
		...(h.ref ? { ref: h.ref } : {}),
	};
}

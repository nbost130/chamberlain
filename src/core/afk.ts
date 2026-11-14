/**
 * Away posture: one record, a held-for-return ledger, and a return brief built from the decision log. Being away
 * changes how the human is informed, never who may approve what.
 *
 * The away record is the database's `away` table. What is held for the principal's return is the item system's: each
 * hold is an item of source "held", open until something closes it (the item system is src/core/store.ts).
 *
 *   bun src/core/afk.ts enter "<their words>" [--return <ISO>] [--cap "<spend note>"] [--since <ISO>]
 *   bun src/core/afk.ts status
 *   bun src/core/afk.ts hold "<thread>" "<what waits for the operator>" ["<safe default taken>"] ["<threadId of an open card>"]
 *        --item <Q-id> [--not-settled "<why>"] [--pr <owner/repo#n>] [--issue <owner/repo#n>] [--branch <owner/repo:branch>] [--run <run id>]
 *        [--thread <threadId> --server <name>]     (--server says which server the thread lives on; without it a missing thread is never "gone")
 *   bun src/core/afk.ts held                     (everything not closed, from any absence, with its notes)
 *   bun src/core/afk.ts note <id> "<what changed>"   (appended to the hold; never write a second hold about the same wait)
 *   bun src/core/afk.ts close <id> "<how it closed>"
 *   bun src/core/afk.ts close-card <server> <request id> "<how it closed>"   (a daemon card hold and its pointer question, by hand)
 *   bun src/core/afk.ts brief
 *   bun src/core/afk.ts exit        (prints the brief, then ends the absence)
 *
 * A hold is a real wait on the operator: a decision, secret, deploy or approval only they can give. An FYI is never a
 * hold. Whatever waits on the operator goes to the decision queue first (src/ask.ts, `"urgent": false` when it can wait),
 * and is held only with --item <that Q-id>: a hold with no --item, with an item that is not on the queue, or with one
 * already answered is refused. A hold that matches something already settled (answered questions, rulings, the decision
 * log; src/core/settled.ts) is refused too; --not-settled "<why>" overrides it and records the reason, and a question
 * asked with its own notSettled reason passes that reason on to its hold. The daemon's own holds (approval, secret and
 * link cards) are written by code (src/core/card-hold.ts), each behind a question that points to its card.
 * The daemon closes holds on its own (src/core/hold-reconcile.ts): a hold tied to a queue item when that item is answered
 * on any path, and a hold with a structured ref when GitHub or the backend shows what it waits on is done. It never reads
 * the prose: only the `item` field links a hold to an answer, so a hold with no item closes through its refs or by `close`.
 */

import {
	HOLD_USAGE,
	heldFrom,
	holdFieldsOk,
	openQuestionOf,
	readHoldArgs,
	refuseIfSettled,
	requireItem,
} from "./afk-args.ts";
import {
	type Afk,
	appendHeld,
	closeHeld,
	type Decision,
	fyiReason,
	HELD,
	type Held,
	heldId,
	heldOpen,
	noteHeld,
	readAfk,
} from "./afk-held.ts";
import { closeCardByHand } from "./card-hold.ts";
import { principal, selfCommand } from "./config.ts";
import { defaultStore } from "./default-store.ts";
import { awayModeLine } from "./messages.ts";
import { startup } from "./migrate.ts";
import type { Store } from "./store.ts";

/** Pure: the plain-words return brief. Newest facts last in each section. */
export function briefMarkdown(a: Afk, decisions: Decision[], open: Held[], events: { event: string }[]): string {
	const since = (t: string) => t >= a.enteredAt;
	const ds = decisions.filter((d) => since(d.t));
	const hs = open;
	const count = (name: string) => events.filter((e) => e.event === name).length;
	const alarms = count("alarm");
	const out = [
		`Away since ${a.enteredAt}${a.expectedReturn ? ` (expected back ${a.expectedReturn})` : ""}. Their words: "${a.words}"`,
		"",
		`Waiting on ${principal()} (${hs.length}):`,
		...(hs.length
			? hs.flatMap((h) => [
					`- ${h.thread}: ${h.what}${h.taken ? ` — meanwhile: ${h.taken}` : ""}`,
					...(h.notes ?? []).map((n) => `  - note ${n.t.slice(5, 16)}: ${n.text}`),
				])
			: ["- nothing"]),
		"",
		`Decided for ${principal()} (${ds.length}):`,
		...(ds.length ? ds.map((d) => `- ${d.thread}: ${d.decision} (${d.ruling})`) : ["- nothing"]),
		"",
		`Watcher health: ${count("fire")} wakes sent, ${count("skip-empty-wait") + count("held-by-daemon")} handled in code, ${count("deliver-stale")} wakes stuck undelivered for over a day, ${alarms} alarms.`,
	];
	return out.join("\n");
}

/** The return brief for an absence, from the decision log, what is held and the events since it began (read with SQL). */
export function brief(store: Store, a: Afk): string {
	return briefMarkdown(
		a,
		store.decisions.list(),
		heldOpen(store),
		store.events.query({
			since: a.enteredAt,
			events: ["fire", "skip-empty-wait", "held-by-daemon", "deliver-stale", "alarm"],
		}),
	);
}

/** Prints a usage or refusal line and exits 2. */
export function usageExit(message: string): never {
	console.error(message);
	process.exit(2);
}

/** Prints the error of a command that failed and exits 1. */
function failExit(e: unknown): never {
	console.error((e as Error).message);
	process.exit(1);
}

type Command = (store: Store, rest: string[]) => void;

const enterCommand: Command = (store, rest) => {
	const words = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--"))[0];
	if (!words) usageExit('usage: afk.ts enter "<their words>" [--return ISO] [--cap "<note>"]');
	const flag = (n: string) => {
		const i = rest.indexOf(n);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const a: Afk = {
		enteredAt: flag("--since") ?? new Date().toISOString(),
		words,
		...(flag("--return") ? { expectedReturn: flag("--return") } : {}),
		...(flag("--cap") ? { spendNote: flag("--cap") } : {}),
	};
	store.away.enter(a);
	console.log("away since", a.enteredAt);
};

const statusCommand: Command = (store) => {
	const a = readAfk(store);
	console.log(a ? awayModeLine(a) : "not away");
	const beat = store.state.get("heartbeat");
	console.log("heartbeat:", beat ? JSON.stringify(beat) : "none");
};

const holdCommand: Command = (store, rest) => {
	const h = readHoldArgs(rest);
	const fyi = h.thread && h.what ? fyiReason(h.thread, h.what) : undefined;
	if (fyi)
		usageExit(
			`afk.ts hold: refused, this reads as an FYI (${fyi}). A hold is a real wait on ${principal()}; an FYI is never held. Log what you decided with: ${selfCommand("decided")} "<thread>" "<what I decided>" "<ruling cited>"`,
		);
	if (!h.thread || !h.what || !holdFieldsOk(h)) usageExit(HOLD_USAGE);
	const item = requireItem(h.item);
	const queued = openQuestionOf(store, item);
	const notSettled = h.notSettledFlag?.trim() || undefined;
	if (h.notSettledFlag !== undefined && !notSettled) usageExit(HOLD_USAGE);
	// A question asked with its own notSettled reason has been through the check already; the hold inherits the reason and records it.
	const inherited = !notSettled ? queued.notSettled : undefined;
	if (!notSettled && !inherited)
		refuseIfSettled(store, {
			title: h.what,
			context: h.taken,
			thread: h.thread,
			item,
			run: h.raw.runId,
			pr: h.raw.pr,
			issue: h.raw.issue,
			branch: h.raw.branch,
		});
	const why = notSettled || inherited ? (notSettled ?? `inherited from ${item}: ${inherited}`) : undefined;
	appendHeld(store, heldFrom({ ...h, thread: h.thread, what: h.what }, item, why));
	console.log("held");
};

const heldCommand: Command = (store) => {
	for (const h of heldOpen(store)) {
		console.log(`${heldId(h)} | ${h.t.slice(5, 16)} | ${h.thread} | ${h.what}${h.taken ? ` | ${h.taken}` : ""}`);
		for (const n of h.notes ?? []) console.log(`    note ${n.t.slice(5, 16)}: ${n.text}`);
	}
};

const noteCommand: Command = (store, rest) => {
	const [id, text] = rest;
	if (!id || !text) usageExit('usage: afk.ts note <id> "<what changed>"');
	try {
		console.log(`noted: ${noteHeld(store, id, text).thread}`);
	} catch (e) {
		failExit(e);
	}
};

/** The card an open hold waits on: the one it carries, or the one its server and request ID name. None for an ordinary hold. */
function cardOfHold(held: Held): { server: string; requestId: string } | undefined {
	if (held.card) return held.card;
	const { server, requestId } = held;
	return server && requestId ? { server, requestId } : undefined;
}

const closeCommand: Command = (store, rest) => {
	const [id, how] = rest;
	if (!id || !how) usageExit('usage: afk.ts close <id> "<how it closed>"');
	try {
		// A daemon card hold never closes alone: by hand it closes with its pointer question, as close-card does.
		const h = store.items.get(HELD, id);
		const card = h && h.status !== "resolved" ? cardOfHold(h.payload as Held) : undefined;
		if (card) {
			const n = closeCardByHand(store, card, how);
			console.log(`closed card ${card.server} ${card.requestId}: ${n.holds} hold(s), ${n.questions} question(s)`);
		} else console.log(`closed: ${closeHeld(store, id, how).thread}`);
	} catch (e) {
		failExit(e);
	}
};

const closeCardCommand: Command = (store, rest) => {
	const [server, requestId, how] = rest;
	if (!server || !requestId || !how) usageExit('usage: afk.ts close-card <server> <request id> "<how it closed>"');
	try {
		const n = closeCardByHand(store, { server, requestId }, how);
		console.log(`closed card ${server} ${requestId}: ${n.holds} hold(s), ${n.questions} question(s)`);
	} catch (e) {
		failExit(e);
	}
};

const briefCommand: Command = (store) => {
	const a = readAfk(store);
	console.log(a ? brief(store, a) : "not away");
};

const exitCommand: Command = (store) => {
	const a = readAfk(store);
	if (!a) {
		console.log("not away");
		return;
	}
	console.log(brief(store, a));
	store.away.exit(new Date().toISOString());
	console.log("\nreturned; the absence is ended and stays on record");
};

const COMMANDS = new Map<string, Command>([
	["enter", enterCommand],
	["status", statusCommand],
	["hold", holdCommand],
	["held", heldCommand],
	["note", noteCommand],
	["close", closeCommand],
	["close-card", closeCardCommand],
	["brief", briefCommand],
	["exit", exitCommand],
]);

export function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const store = defaultStore();
	const [cmd, ...rest] = argv;
	const run = cmd === undefined ? undefined : COMMANDS.get(cmd);
	if (!run) usageExit("usage: afk.ts enter|status|hold|held|note|close|close-card|brief|exit");
	run(store, rest);
}

if (import.meta.main) main();

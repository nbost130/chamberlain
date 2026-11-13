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
import { createHash } from "node:crypto";
import { REPO, principal, principalPoss } from "./config.ts";
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import { closeCardByHand } from "./card-hold.ts";
import { getQuestion } from "./questions.ts";
import { findSettled, refusalLines } from "./settled.ts";
import type { AwayRecord, Store } from "./store.ts";

export type Afk = AwayRecord;
/**
 * What a hold waits on, in fields the daemon can check without reading prose: a PR or issue ("owner/repo#n"), a remote
 * branch ("owner/repo:branch"), a run ID and the thread that holds its card. Every field is optional.
 */
export type HoldRef = { pr?: string; issue?: string; branch?: string; runId?: string; threadId?: string };
export type HeldNote = { t: string; text: string };
/** `item` is the decision-queue item the hold waits on, so an answer on any path can close it. `notes` are appended to it, never a second hold. */
/**
 * The card a daemon's card hold waits on, persisted on the hold so closing it needs nothing in memory: after a restart the
 * reconciler (card-hold.ts `reconcileCardHolds`) reads the server, the thread and the request ID from here.
 */
export type CardRef = { server: string; threadId: string; requestId: string };
export type Held = { t: string; thread: string; what: string; taken?: string; server?: string; requestId?: string; threadId?: string; item?: string; ref?: HoldRef; notes?: HeldNote[]; /** Why this was held although a settled record matched it. */ notSettled?: string; /** A daemon card hold's card. */ card?: CardRef; /** A card hold's store sequence value when it was written (card-hold.ts): only a read started with a greater one may close it. */ seq?: number };
/** Pure: is this a daemon's card hold? It closes only when its card resolves, never because its pointer question was answered. */
export const isCardHold = (h: Held): boolean => h.card !== undefined || (typeof h.requestId === "string" && h.requestId !== "");
const ITEM_ID = /^Q-[a-z0-9]{4,16}$/;
const SLUG = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
/** The shapes a ref field may take. A field in any other shape is never acted on. */
export const REF_SHAPES = {
	pr: new RegExp(`^${SLUG}#[1-9][0-9]{0,8}$`),
	issue: new RegExp(`^${SLUG}#[1-9][0-9]{0,8}$`),
	branch: new RegExp(`^${SLUG}:[A-Za-z0-9_./-]{1,200}$`),
	runId: /^[A-Za-z0-9_-]{4,80}$/,
	threadId: /^[A-Za-z0-9_-]{4,80}$/,
} as const;
/** Pure: the fields of a ref that are well formed, or undefined when none is. */
export function cleanRef(r: unknown): HoldRef | undefined {
	if (!r || typeof r !== "object") return undefined;
	const out: HoldRef = {};
	for (const k of Object.keys(REF_SHAPES) as (keyof HoldRef)[]) {
		const v = (r as Record<string, unknown>)[k];
		if (typeof v === "string" && REF_SHAPES[k].test(v)) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}
export type Decision = { t: string; thread: string; decision: string; ruling: string };

/** The item source and kind of what is held for the principal's return. */
export const HELD = "held";

/** The record, or undefined when not away. */
export const readAfk = (store: Store): Afk | undefined => store.away.current();

/** The standing-rules line every wake carries while away. */
export function mandateLine(a: Afk): string {
	const back = a.expectedReturn ? ` Expected back ${a.expectedReturn}.` : "";
	const spend = a.spendNote ? ` Spend: ${a.spendNote}.` : "";
	return `- AFK MANDATE (${principal()}, since ${a.enteredAt}): "${a.words}"${back}${spend} Standing until ${principalPoss()} next genuine message. Hold-for-return: anything on the ASK list waits (take the safe default or let the thread work on something else). Put it on ${principalPoss()} queue first with \`bun ${REPO}/src/ask.ts '<json>'\` (add \`"urgent": false\` when it can wait: it is listed below the urgent ones and sends no notification), then hold it for the return brief with \`bun ${REPO}/src/core/afk.ts hold ... --item <the Q-id>\`; a hold with no queue item is refused, and so is anything already settled (it prints the answer). Never an FYI. Command approvals and secret requests are ${principalPoss()}: the daemon holds them itself, so none wakes you. Merges only synchronous, pinned to a green reviewed head, never red. Destructive, irreversible and security-sensitive actions are never pre-authorized by this mandate.`;
}

/** A short stable handle for a held entry. */
export const heldId = (h: Held) => createHash("sha256").update([h.t, h.server ?? "", h.thread, h.requestId ?? "", h.what].join("\n")).digest("hex").slice(0, 8);

/** Holds something for the principal's return. Returns its handle. */
export function appendHeld(store: Store, h: Omit<Held, "t">, now = new Date()): string {
	const held: Held = { t: now.toISOString(), ...h };
	const key = heldId(held);
	// A hold only waits to be read and closed, so it never notifies: mode silenced.
	store.items.observe({ source: HELD, kind: "hold", dedupKey: key, mode: "silenced", ...(held.item ? { subject: { kind: "question", id: held.item } } : {}), payload: held, now: now.getTime() });
	return key;
}

/** Everything held and not closed, oldest first. */
export const heldOpen = (store: Store): Held[] => store.items.list({ source: HELD, status: ["triggered", "acknowledged"] }).map((i) => i.payload as Held);

/** Closes one held entry by its handle. Throws when there is no open entry by that handle. */
export function closeHeld(store: Store, id: string, how: string, now = new Date()): Held {
	return store.tx(() => {
		const i = store.items.get(HELD, id);
		if (!i || i.status === "resolved") throw Error(`no open held item ${id}`);
		store.items.resolve(HELD, id, now.getTime(), { closedAt: now.toISOString(), how });
		return i.payload as Held;
	});
}

/**
 * Close every open hold the matcher gives a reason for, in one transaction. Resolving is idempotent and a closed hold is
 * no longer open, so a second pass matches nothing. Returns how many closed.
 */
export function closeHeldWhere(store: Store, why: (h: Held) => string | undefined, now = new Date()): number {
	return store.tx(() => {
		let n = 0;
		for (const h of heldOpen(store)) {
			const how = why(h);
			if (!how) continue;
			store.items.resolve(HELD, heldId(h), now.getTime(), { closedAt: now.toISOString(), how });
			n++;
		}
		return n;
	});
}
const closeWhere = (store: Store, pick: (h: Held) => boolean, how: string, now = new Date()): number => closeHeldWhere(store, (h) => (pick(h) ? how : undefined), now);

/** Adds a note to an open hold. The hold is never rewritten and no second entry is made. Throws when there is no open hold by that handle. */
export function noteHeld(store: Store, id: string, text: string, now = new Date()): Held {
	return store.tx(() => {
		const i = store.items.get(HELD, id);
		if (!i || i.status === "resolved") throw Error(`no open held item ${id}`);
		const notes = [...(((i.payload as Held).notes) ?? []), { t: now.toISOString(), text }];
		return store.items.patch(HELD, id, { notes })!.payload as Held;
	});
}
/** The queue item a hold waits on: its structured `item` field and nothing else. The prose is never read. */
export const itemIdOf = (h: Held): string | undefined => (h.item && ITEM_ID.test(h.item) ? h.item : undefined);
/**
 * A card or approval left thread `threadId` on `server`: close the Steward's holds that name that thread (and no request),
 * on the same server when they name one. A daemon's card hold is never closed here: it closes only with its pointer question,
 * in one transaction, when its own (server, request ID) is no longer waiting (card-hold.ts `closeCard`). A hold with no card
 * link is a decision, so it stays.
 */
export const closeHeldForCard = (store: Store, server: string, threadId: string, how: string): number =>
	closeWhere(store, (h) => !isCardHold(h) && h.threadId !== undefined && h.threadId === threadId && (h.server === undefined || h.server === server), how);
/**
 * Pure: why a hold is not a hold. A hold is a real wait on the operator, and an FYI waits on nothing, so the ledger refuses it
 * in code and points at the decision log. Only an opening counts: the thread, or the text, STARTS with "FYI", "for your
 * information", "no action needed" or "nothing needed" (after any spaces and punctuation). A hold that says "waits on the
 * operator; no action from builders until then" is a real wait and passes.
 */
export function fyiReason(thread: string, what: string): string | undefined {
	for (const part of [thread, what]) {
		const hit = part.match(/^[\s\p{P}]*(FYI\b|for your information\b|no action (?:is )?(?:needed|required|necessary)\b|nothing (?:is )?(?:needed|required|necessary)\b)/iu);
		if (hit) return `"${hit[1]}"`;
	}
	return undefined;
}
/** Pure: is this hold waiting on queue item `itemId`? Only by its `item` field: an ID named in its text means nothing. */
export const heldForItem = (h: Held, itemId: string) => h.item === itemId;
/**
 * A queue item's answer went straight to its thread, so no answer wake tells the Steward to close its hold: close
 * what was held against the item, as `afk.ts close` would. Returns how many closed; 0 when nothing was held.
 */
export function closeHeldForItem(store: Store, itemId: string, how: string): number {
	if (!ITEM_ID.test(itemId)) return 0;
	// A card hold waits on its card, not on its pointer question's answer.
	return closeWhere(store, (h) => heldForItem(h, itemId) && !isCardHold(h), how);
}

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
		...(hs.length ? hs.flatMap((h) => [`- ${h.thread}: ${h.what}${h.taken ? ` — meanwhile: ${h.taken}` : ""}`, ...(h.notes ?? []).map((n) => `  - note ${n.t.slice(5, 16)}: ${n.text}`)]) : ["- nothing"]),
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
	return briefMarkdown(a, store.decisions.list(), heldOpen(store), store.events.query({ since: a.enteredAt, events: ["fire", "skip-empty-wait", "held-by-daemon", "deliver-stale", "alarm"] }));
}

function main() {
	startup();
	const store = defaultStore();
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "enter") {
		const words = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--"))[0];
		if (!words) { console.error('usage: afk.ts enter "<their words>" [--return ISO] [--cap "<note>"]'); process.exit(2); }
		const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
		const a: Afk = { enteredAt: flag("--since") ?? new Date().toISOString(), words, ...(flag("--return") ? { expectedReturn: flag("--return") } : {}), ...(flag("--cap") ? { spendNote: flag("--cap") } : {}) };
		store.away.enter(a);
		console.log("away since", a.enteredAt);
	} else if (cmd === "status") {
		const a = readAfk(store);
		console.log(a ? mandateLine(a) : "not away");
		const beat = store.state.get("heartbeat");
		console.log("heartbeat:", beat ? JSON.stringify(beat) : "none");
	} else if (cmd === "hold") {
		const HOLD_USAGE = 'usage: afk.ts hold "<thread>" "<what waits>" ["<default taken>"] ["<threadId of an open card>"] --item <Q-id> [--not-settled "<why>"] [--pr <owner/repo#n>] [--issue <owner/repo#n>] [--branch <owner/repo:branch>] [--run <run id>] [--thread <threadId> --server <name>]';
		const flags: Record<string, string> = {};
		const pos: string[] = [];
		for (let k = 0; k < rest.length; k++) {
			const a = rest[k]!;
			if (!a.startsWith("--")) { pos.push(a); continue; }
			if (!["--item", "--not-settled", "--pr", "--issue", "--branch", "--run", "--thread", "--server"].includes(a) || rest[k + 1] === undefined) { console.error(HOLD_USAGE); process.exit(2); }
			flags[a] = rest[++k]!;
		}
		const [thread, what, taken, threadId] = pos;
		const item = flags["--item"];
		const raw = { pr: flags["--pr"], issue: flags["--issue"], branch: flags["--branch"], runId: flags["--run"], threadId: flags["--thread"] };
		const server = flags["--server"];
		const ref = cleanRef(raw);
		const given = Object.entries(raw).filter(([, v]) => v !== undefined);
		const fyi = thread && what ? fyiReason(thread, what) : undefined;
		if (fyi) { console.error(`afk.ts hold: refused, this reads as an FYI (${fyi}). A hold is a real wait on ${principal()}; an FYI is never held. Log what you decided with: bun ${new URL("./decided.ts", import.meta.url).pathname} "<thread>" "<what I decided>" "<ruling cited>"`); process.exit(2); }
		if (!thread || !what || (item !== undefined && !ITEM_ID.test(item)) || Object.keys(ref ?? {}).length !== given.length || (server !== undefined && (!/^[A-Za-z0-9_.-]{1,40}$/.test(server) || (!raw.threadId && !threadId)))) { console.error(HOLD_USAGE); process.exit(2); }
		if (!item) { console.error(`afk.ts hold: refused, a hold needs --item <Q-id>. Anything that waits on ${principal()} goes on the decision queue first: bun ${REPO}/src/ask.ts '<json>' (add "urgent": false if it can wait), then hold it with the item ID it prints.`); process.exit(2); }
		const queued = getQuestion(store, item);
		if (!queued) { console.error(`afk.ts hold: refused, ${item} is not on the decision queue. File the question with ask.ts first, then hold it with the item ID it prints.`); process.exit(2); }
		// A hold on a question already answered waits on nothing: the answer is what the hold was for.
		if (queued.status !== "open") { console.error(`afk.ts hold: refused, ${item} is already answered (${queued.answer ? `"${queued.answer.label}"` : "on its card"}). Act on the answer; nothing waits on ${principal()}.`); process.exit(2); }
		const notSettled = flags["--not-settled"]?.trim() || undefined;
		if (flags["--not-settled"] !== undefined && !notSettled) { console.error(HOLD_USAGE); process.exit(2); }
		// A question asked with its own notSettled reason has been through the check already; the hold inherits the reason and records it.
		const inherited = !notSettled ? queued.notSettled : undefined;
		if (!notSettled && !inherited) {
			const { matches, skipped } = findSettled(store, { title: what, context: taken, thread, item, run: raw.runId, pr: raw.pr, issue: raw.issue, branch: raw.branch });
			for (const k of skipped) console.error(`afk.ts hold: the settled check could not read ${k}`);
			if (matches.length) { console.error(refusalLines("afk.ts hold", matches, 'add --not-settled "<why this is a different question>"').join("\n")); process.exit(2); }
		}
		appendHeld(store, { thread, what, ...(taken ? { taken } : {}), ...(threadId ? { threadId } : {}), ...(server ? { server } : {}), item, ...(notSettled || inherited ? { notSettled: notSettled ?? `inherited from ${item}: ${inherited}` } : {}), ...(ref ? { ref } : {}) });
		console.log("held");
	} else if (cmd === "held") {
		for (const h of heldOpen(store)) {
			console.log(`${heldId(h)} | ${h.t.slice(5, 16)} | ${h.thread} | ${h.what}${h.taken ? ` | ${h.taken}` : ""}`);
			for (const n of h.notes ?? []) console.log(`    note ${n.t.slice(5, 16)}: ${n.text}`);
		}
	} else if (cmd === "note") {
		const [id, text] = rest;
		if (!id || !text) { console.error('usage: afk.ts note <id> "<what changed>"'); process.exit(2); }
		try { console.log(`noted: ${noteHeld(store, id, text).thread}`); } catch (e) { console.error((e as Error).message); process.exit(1); }
	} else if (cmd === "close") {
		const [id, how] = rest;
		if (!id || !how) { console.error('usage: afk.ts close <id> "<how it closed>"'); process.exit(2); }
		try {
			// A daemon card hold never closes alone: by hand it closes with its pointer question, as close-card does.
			const h = store.items.get(HELD, id);
			const card = h && h.status !== "resolved" ? (h.payload as Held).card ?? ((h.payload as Held).requestId && (h.payload as Held).server ? { server: (h.payload as Held).server!, requestId: (h.payload as Held).requestId! } : undefined) : undefined;
			if (card) { const n = closeCardByHand(store, card.server, card.requestId, how); console.log(`closed card ${card.server} ${card.requestId}: ${n.holds} hold(s), ${n.questions} question(s)`); }
			else console.log(`closed: ${closeHeld(store, id, how).thread}`);
		} catch (e) { console.error((e as Error).message); process.exit(1); }
	} else if (cmd === "close-card") {
		const [server, requestId, how] = rest;
		if (!server || !requestId || !how) { console.error('usage: afk.ts close-card <server> <request id> "<how it closed>"'); process.exit(2); }
		try { const n = closeCardByHand(store, server, requestId, how); console.log(`closed card ${server} ${requestId}: ${n.holds} hold(s), ${n.questions} question(s)`); } catch (e) { console.error((e as Error).message); process.exit(1); }
	} else if (cmd === "brief") {
		const a = readAfk(store);
		console.log(a ? brief(store, a) : "not away");
	} else if (cmd === "exit") {
		const a = readAfk(store);
		if (!a) { console.log("not away"); return; }
		console.log(brief(store, a));
		store.away.exit(new Date().toISOString());
		console.log("\nreturned; the absence is ended and stays on record");
	} else {
		console.error("usage: afk.ts enter|status|hold|held|note|close|close-card|brief|exit");
		process.exit(2);
	}
}

if (import.meta.main) main();

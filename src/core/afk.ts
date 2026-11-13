/**
 * Away posture: one record, a held-for-return ledger, and a return brief built from the decision log. Being away
 * changes how the human is informed, never who may approve what.
 *
 * The away record is the database's `away` table. What is held for the principal's return is the item system's: each
 * hold is an item of source "held", open until something closes it (the item system is src/core/store.ts).
 *
 *   bun src/core/afk.ts enter "<their words>" [--return <ISO>] [--cap "<spend note>"] [--since <ISO>]
 *   bun src/core/afk.ts status
 *   bun src/core/afk.ts hold "<thread>" "<what waits for the operator>" ["<safe default taken>"] ["<threadId of an open card>"] [--item <Q-id>]
 *   bun src/core/afk.ts held                     (everything not closed, from any absence)
 *   bun src/core/afk.ts close <id> "<how it closed>"
 *   bun src/core/afk.ts brief
 *   bun src/core/afk.ts exit        (prints the brief, then ends the absence)
 */
import { createHash } from "node:crypto";
import { REPO, principal, principalPoss } from "./config.ts";
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import type { AwayRecord, Store } from "./store.ts";

export type Afk = AwayRecord;
/** `item` is the decision-queue item the hold waits on, so an answer sent straight to its thread can close it. */
export type Held = { t: string; thread: string; what: string; taken?: string; server?: string; requestId?: string; threadId?: string; item?: string };
const ITEM_ID = /^Q-[a-z0-9]{4,16}$/;
export type Decision = { t: string; thread: string; decision: string; ruling: string };

/** The item source and kind of what is held for the principal's return. */
export const HELD = "held";

/** The record, or undefined when not away. */
export const readAfk = (store: Store): Afk | undefined => store.away.current();

/** The standing-rules line every wake carries while away. */
export function mandateLine(a: Afk): string {
	const back = a.expectedReturn ? ` Expected back ${a.expectedReturn}.` : "";
	const spend = a.spendNote ? ` Spend: ${a.spendNote}.` : "";
	return `- AFK MANDATE (${principal()}, since ${a.enteredAt}): "${a.words}"${back}${spend} Standing until ${principalPoss()} next genuine message. Hold-for-return: anything on the ASK list waits (take the safe default or let the thread work on something else) and goes in the return brief via \`bun ${REPO}/src/core/afk.ts hold\`. Command approvals and secret requests are ${principalPoss()}: the daemon holds them itself, so none wakes you. Merges only synchronous, pinned to a green reviewed head, never red. Destructive, irreversible and security-sensitive actions are never pre-authorized by this mandate.`;
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

function closeWhere(store: Store, pick: (h: Held) => boolean, how: string, now = new Date()): number {
	return store.tx(() => {
		const hit = heldOpen(store).filter(pick);
		for (const h of hit) store.items.resolve(HELD, heldId(h), now.getTime(), { closedAt: now.toISOString(), how });
		return hit.length;
	});
}
/** A card or approval left its thread: close what was held against it. A hold with no card link is a decision, so it stays. */
export const closeHeldForCard = (store: Store, threadId: string, requestId: string, how: string): number => closeWhere(store, (h) => h.requestId === requestId || h.threadId === threadId, how);
/** Pure: is this hold waiting on queue item `itemId`? By its `item` link, or by the item ID named as a word in its text. */
export const heldForItem = (h: Held, itemId: string) => h.item === itemId || new RegExp(`(^|[^A-Za-z0-9-])${itemId}(?![A-Za-z0-9-])`).test(`${h.thread}\n${h.what}`);
/**
 * A queue item's answer went straight to its thread, so no answer wake tells the Steward to close its hold: close
 * what was held against the item, as `afk.ts close` would. Returns how many closed; 0 when nothing was held.
 */
export function closeHeldForItem(store: Store, itemId: string, how: string): number {
	if (!ITEM_ID.test(itemId)) return 0;
	return closeWhere(store, (h) => heldForItem(h, itemId), how);
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
		...(hs.length ? hs.map((h) => `- ${h.thread}: ${h.what}${h.taken ? ` — meanwhile: ${h.taken}` : ""}`) : ["- nothing"]),
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
		const at = rest.indexOf("--item");
		const item = at >= 0 ? rest[at + 1] : undefined;
		const [thread, what, taken, threadId] = at >= 0 ? rest.filter((_, k) => k !== at && k !== at + 1) : rest;
		if (!thread || !what || (at >= 0 && !ITEM_ID.test(item ?? ""))) { console.error('usage: afk.ts hold "<thread>" "<what waits>" ["<default taken>"] ["<threadId of an open card>"] [--item <Q-id>]'); process.exit(2); }
		appendHeld(store, { thread, what, ...(taken ? { taken } : {}), ...(threadId ? { threadId } : {}), ...(item ? { item } : {}) });
		console.log("held");
	} else if (cmd === "held") {
		for (const h of heldOpen(store)) console.log(`${heldId(h)} | ${h.t.slice(5, 16)} | ${h.thread} | ${h.what}${h.taken ? ` | ${h.taken}` : ""}`);
	} else if (cmd === "close") {
		const [id, how] = rest;
		if (!id || !how) { console.error('usage: afk.ts close <id> "<how it closed>"'); process.exit(2); }
		try { console.log(`closed: ${closeHeld(store, id, how).thread}`); } catch (e) { console.error((e as Error).message); process.exit(1); }
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
		console.error("usage: afk.ts enter|status|hold|held|close|brief|exit");
		process.exit(2);
	}
}

if (import.meta.main) main();

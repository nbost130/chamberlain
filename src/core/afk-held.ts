/** The held ledger: what the Steward holds for the operator, and appending, reading and closing a hold. */
import { createHash } from "node:crypto";
import type { AwayRecord, Store } from "./store.ts";

export type Afk = AwayRecord;
/**
 * What a hold waits on, in fields the daemon can check without reading prose: a PR or issue ("owner/repo#n"), a remote
 * branch ("owner/repo:branch"), a run ID and the thread that holds its card. Every field is optional.
 */
export type HoldRef = { pr?: string; issue?: string; branch?: string; runId?: string; threadId?: string };
type HeldNote = { t: string; text: string };
/** `item` is the decision-queue item the hold waits on, so an answer on any path can close it. `notes` are appended to it, never a second hold. */
/**
 * The card a daemon's card hold waits on, persisted on the hold so closing it needs nothing in memory: after a restart the
 * reconciler (card-hold.ts `reconcileCardHolds`) reads the server, the thread and the request ID from here.
 */
export type CardRef = { server: string; threadId: string; requestId: string };
export type Held = {
	t: string;
	thread: string;
	what: string;
	taken?: string;
	server?: string;
	requestId?: string;
	threadId?: string;
	item?: string;
	ref?: HoldRef;
	notes?: HeldNote[] /** Why this was held although a settled record matched it. */;
	notSettled?: string /** A daemon card hold's card. */;
	card?: CardRef /** A card hold's store sequence value when it was written (card-hold.ts): only a read started with a greater one may close it. */;
	seq?: number;
};
/** Pure: is this a daemon's card hold? It closes only when its card resolves, never because its pointer question was answered. */
export const isCardHold = (h: Held): boolean =>
	h.card !== undefined || (typeof h.requestId === "string" && h.requestId !== "");
export const ITEM_ID = /^Q-[a-z0-9]{4,16}$/;
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

/** A short stable handle for a held entry. */
export const heldId = (h: Held) =>
	createHash("sha256")
		.update([h.t, h.server ?? "", h.thread, h.requestId ?? "", h.what].join("\n"))
		.digest("hex")
		.slice(0, 8);

/** Holds something for the principal's return. Returns its handle. */
export function appendHeld(store: Store, h: Omit<Held, "t">, now = new Date()): string {
	const held: Held = { t: now.toISOString(), ...h };
	const key = heldId(held);
	// A hold only waits to be read and closed, so it never notifies: mode silenced.
	store.items.observe({
		source: HELD,
		kind: "hold",
		dedupKey: key,
		mode: "silenced",
		...(held.item ? { subject: { kind: "question", id: held.item } } : {}),
		payload: held,
		now: now.getTime(),
	});
	return key;
}

/** Everything held and not closed, oldest first. */
export const heldOpen = (store: Store): Held[] =>
	store.items.list({ source: HELD, status: ["triggered", "acknowledged"] }).map((i) => i.payload as Held);

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
const closeWhere = (store: Store, pick: (h: Held) => boolean, how: string, now = new Date()): number =>
	closeHeldWhere(store, (h) => (pick(h) ? how : undefined), now);

/** Adds a note to an open hold. The hold is never rewritten and no second entry is made. Throws when there is no open hold by that handle. */
export function noteHeld(store: Store, id: string, text: string, now = new Date()): Held {
	return store.tx(() => {
		const i = store.items.get(HELD, id);
		if (!i || i.status === "resolved") throw Error(`no open held item ${id}`);
		const notes = [...((i.payload as Held).notes ?? []), { t: now.toISOString(), text }];
		const patched = store.items.patch(HELD, id, { notes });
		if (!patched) throw Error(`no open held item ${id}`);
		return patched.payload as Held;
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
	closeWhere(
		store,
		(h) =>
			!isCardHold(h) &&
			h.threadId !== undefined &&
			h.threadId === threadId &&
			(h.server === undefined || h.server === server),
		how,
	);
/**
 * Pure: why a hold is not a hold. A hold is a real wait on the operator, and an FYI waits on nothing, so the ledger refuses it
 * in code and points at the decision log. Only an opening counts: the thread, or the text, STARTS with "FYI", "for your
 * information", "no action needed" or "nothing needed" (after any spaces and punctuation). A hold that says "waits on the
 * operator; no action from builders until then" is a real wait and passes.
 */
export function fyiReason(thread: string, what: string): string | undefined {
	for (const part of [thread, what]) {
		const hit = part.match(
			/^[\s\p{P}]*(FYI\b|for your information\b|no action (?:is )?(?:needed|required|necessary)\b|nothing (?:is )?(?:needed|required|necessary)\b)/iu,
		);
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

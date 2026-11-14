/**
 * Closing the cards that resolved in their threads: each open card is read against its own (server, thread), a card hold
 * and its pointer question close together only on positive evidence, and a card with no evidence for too long raises an alarm.
 */
import type { CardRef } from "./afk.ts";
import { closeCard } from "./card-hold.ts";
import { CARD_UNVERIFIED, cardAlarmKey, cardKey, type OpenCard, openCards } from "./card-open.ts";
import type { Store } from "./store.ts";

/**
 * What a read of one thread on one server says of its cards. `ok: true`: the request IDs it saw waiting, and those whose own
 * item it saw in a terminal status (`resolved`, the only closing evidence). It need not list every card of the thread. `ok: false`
 * is anything else (the server down or not connected, a failed or malformed read): nothing is known, and nothing closes.
 */
export type CardThreadRead =
	| { ok: true; waiting: ReadonlySet<string>; resolved: ReadonlySet<string> }
	| { ok: false; reason: string };

/** A card the reconciler found no closing evidence for this pass, and why. */
export type Unverified = { card: OpenCard; reason: string };
export type CardReconcile = {
	closed: CardRef[];
	verified: OpenCard[];
	unverified: Unverified[];
	failed: { server: string; reason: string }[];
};

type ThreadRead = { seq: number; r: CardThreadRead };

/** One reconcile pass: the store, the read it asks, the reads already made (one per server and thread), what it reports, and its clock. */
type Pass = {
	store: Store;
	read: (server: string, threadId: string) => Promise<CardThreadRead>;
	reads: Map<string, ThreadRead>;
	out: CardReconcile;
	now: () => Date;
};

/**
 * The read of one (server, thread), made once per pass. A new value is taken from the store's sequence BEFORE the read is asked for: every
 * hold written with a smaller value was committed before the read started. A read that fails, throws or breaks the contract is `ok: false`
 * and is also reported in `out.failed`.
 */
async function readOnce(pass: Pass, server: string, threadId: string): Promise<ThreadRead> {
	const { store, read, reads, out } = pass;
	const key = `${server}\u0000${threadId}`;
	const had = reads.get(key);
	if (had) return had;
	const seq = store.sequence.next();
	const r = await read(server, threadId).then(
		(x) =>
			isCardThreadRead(x)
				? x
				: ({ ok: false, reason: "the read did not keep the CardThreadRead contract" } as CardThreadRead),
		(e): CardThreadRead => ({ ok: false, reason: String(e instanceof Error ? e.message : e).slice(0, 200) }),
	);
	const got = { seq, r };
	reads.set(key, got);
	if (!r.ok) out.failed.push({ server, reason: r.reason });
	return got;
}

type Judgement = { verdict: "verified" } | { verdict: "close" } | { verdict: "unverified"; reason: string };
const unverified = (reason: string): Judgement => ({ verdict: "unverified", reason });

/** What a card's thread read says of it: seen waiting (verified), seen resolved after its holds were written (close it), or why it stays open. */
function judge(c: OpenCard, r: CardThreadRead, seq: number): Judgement {
	if (!r.ok) return unverified(r.reason);
	if (r.waiting.has(c.requestId)) return { verdict: "verified" };
	if (!r.resolved.has(c.requestId))
		return unverified(
			"its thread's read does not show the card resolved or waiting (it may be outside the read's history window)",
		);
	if (!c.holds.length || !c.holds.every((h) => h.seq !== undefined && h.seq < seq))
		return unverified(
			c.holds.length
				? "the read did not start after its hold was written"
				: "it has no open hold, only its pointer question",
		);
	return { verdict: "close" };
}

/** Closes a card whose read showed it resolved: hold and question together, once. A card that closes nothing is left unverified. */
function closeResolved({ store, out, now }: Pass, c: OpenCard, threadId: string, seq: number): void {
	const ref = { server: c.server, threadId, requestId: c.requestId };
	const n = closeCard(
		store,
		ref,
		"The card's own item is resolved in its thread (completed, cancelled, failed or interrupted there); closed by the daemon's card reconciler.",
		{ now: now(), writtenBefore: seq },
	);
	if (n.questions || n.holds) out.closed.push(ref);
	else out.unverified.push({ card: c, reason: "the read did not start after its hold was written" });
}

/**
 * Close every card whose own item a read shows resolved: on each tick and at every (re)connection, so a card resolved while the
 * daemon was down does not leave its question and hold open. Each (server, thread) is read once, and BEFORE each read a new
 * value is taken from the store's sequence. A card hold and its pointer question close together, in one transaction, only
 * when ALL of these hold: the read is of the card's own thread on the card's own server; it is `ok: true`; the hold was written
 * with a smaller sequence value (the read started after it); and the read lists the card's request ID in `resolved` (its own
 * item, same thread, a terminal status). A hold written while the read was out stays, and so does its question. A card the read
 * saw still waiting is `verified`. Everything else leaves it open and `unverified`: a read that is `ok: false`, throws or breaks
 * the contract (also `failed`), a card the read did not show at all (it may sit outside a bounded history window), a card in
 * another open status, a card with no known thread or no hold the read started after. A card closes exactly once.
 */
export async function reconcileCardHolds(
	store: Store,
	read: (server: string, threadId: string) => Promise<CardThreadRead>,
	now = () => new Date(),
): Promise<CardReconcile> {
	const out: CardReconcile = { closed: [], verified: [], unverified: [], failed: [] };
	const pass: Pass = { store, read, reads: new Map(), out, now };
	for (const c of openCards(store)) {
		if (!c.threadId) {
			out.unverified.push({ card: c, reason: "neither its hold nor its question names its thread" });
			continue;
		}
		const { seq, r } = await readOnce(pass, c.server, c.threadId);
		const j = judge(c, r, seq);
		if (j.verdict === "verified") out.verified.push(c);
		else if (j.verdict === "unverified") out.unverified.push({ card: c, reason: j.reason });
		else closeResolved(pass, c, c.threadId, seq);
	}
	return out;
}

/**
 * Since when each open card has had no evidence (neither seen waiting nor resolved), kept in the store (a `card-unverified` item per card: its `firstSeen`), so
 * a restart does not reset the count. A verified card's record resolves; an unverifiable one is observed (silenced, never
 * notifying by itself). Returns the cards unverifiable for at least `periodMs`: the engine raises an alarm for each, through
 * its repeat policy. The clock here only times the alarm; it never closes anything.
 */
export function trackUnverified(
	store: Store,
	r: Pick<CardReconcile, "verified" | "unverified">,
	periodMs: number,
	now = Date.now(),
): (Unverified & { since: number })[] {
	return store.tx(() => {
		for (const c of r.verified) {
			store.items.resolve(CARD_UNVERIFIED, cardKey(c), now);
			store.items.resolve("alarm", cardAlarmKey(c), now);
		}
		const overdue: (Unverified & { since: number })[] = [];
		for (const u of r.unverified) {
			const { item } = store.items.observe({
				source: CARD_UNVERIFIED,
				kind: "card",
				dedupKey: cardKey(u.card),
				mode: "silenced",
				payload: {
					server: u.card.server,
					requestId: u.card.requestId,
					threadId: u.card.threadId ?? null,
					reason: u.reason,
				},
				now,
			});
			if (now - item.firstSeen >= periodMs) overdue.push({ ...u, since: item.firstSeen });
		}
		return overdue;
	});
}

/** Pure: the alarm for a card unverifiable too long: it names the hold, the card and the exact command that closes it by hand. */
export function unverifiedAlarm(
	u: Unverified & { since: number },
	closeCommand: string,
): { key: string; title: string; summary: string } {
	const c = u.card;
	const hours = Math.max(0, Math.round((Date.now() - u.since) / 3_600_000));
	return {
		key: cardAlarmKey(c),
		title: `chamberlain cannot see a held question card on ${c.server}`,
		summary: [
			`Card hold ${c.holds.length ? c.holds.map((h) => h.id).join(", ") : "(none open; its pointer question only)"} for ${c.server} request ${c.requestId}${c.threadId ? ` in thread ${c.threadId}` : ""} has shown no evidence (not seen waiting, not seen resolved) for about ${hours} hours: ${u.reason}.`,
			"Nothing closes it on its own. Check the card in its thread; once it is resolved, withdrawn or its thread is gone, close it by hand:",
			closeCommand,
		].join(" "),
	};
}

/** Pure: a read result in the `CardThreadRead` shape. Anything else is treated as `ok: false`. */
function isCardThreadRead(r: unknown): r is CardThreadRead {
	if (!r || typeof r !== "object") return false;
	const o = r as Record<string, unknown>;
	if (o.ok === false) return typeof o.reason === "string";
	const ids = (v: unknown) => v instanceof Set && [...v].every((x) => typeof x === "string");
	return o.ok === true && ids(o.waiting) && ids(o.resolved);
}

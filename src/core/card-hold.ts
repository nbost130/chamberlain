/**
 * The daemon's hold for a card only the operator can clear: a command approval, a secret request, a machine-link request.
 * Nothing that waits on the operator is held without a decision-queue question, so before it holds a card the engine
 * files a question that POINTS to the card (a pointer item): the operator answers on the card in its own thread, and the
 * question and the hold both close when the card leaves the thread. No answering path is built here, and nothing of the
 * card's content travels: the question carries the thread, the server, the card's kind and the adapter's one-line label,
 * never a value, a command's output, or the card's questions and options. A secret card's question is itself `secret`, so
 * it is never posted and the page shows it only as a link to its thread.
 *
 * One question per card: `cardRequest` on the question is the card's request ID, and an open question or hold for the same
 * server and request is reused, so a card seen again files nothing new. The question carries a `notSettled` reason (a
 * pending card is a live request, never a settled question), so the settled check never refuses it.
 *
 * Which cards there are, and their kinds, is the adapter's (`Inspector.waiting`, normalized to `WaitKind` in adapter.ts):
 * this module reads only the normalized fields, so it imports no adapter.
 *
 * A card is keyed by (server, request ID) everywhere: filing, de-duplication, closing and reconciling. Two servers may use
 * the same request ID; one resolving never touches the other. What closing needs, the server, the thread and the request ID,
 * is stored on the hold (`card`) and on the question (`server`, `threadId`, `cardRequest`), so `reconcileCardHolds` can close
 * a card that resolved while the daemon was down.
 *
 * A card hold closes on POSITIVE EVIDENCE ONLY, or by the operator. The one evidence is the backend showing THAT card's own item,
 * matched on (server, request ID), in a terminal status (adapter.ts `WaitingRead.resolved`; for T3: completed, cancelled,
 * failed or interrupted). Absence is never evidence: a backend's read of a thread can be a bounded window of its history (T3's
 * is), so a card missing from it may still wait; a thread that is gone, archived or unreadable proves nothing either. Answering
 * the pointer question changes nothing (the page refuses it and the item reconciler skips it). A hold that sees no terminal
 * evidence for longer than a set period raises an alarm in the engine, naming the hold, the card and the command that closes it
 * by hand (`closeCardByHand`, `afk.ts close-card`). Nothing closes such a card on its own.
 */
import {
	appendHeld,
	closeHeldForCard,
	closeHeldWhere,
	heldId,
	heldOpen,
	isCardHold,
	type CardRef,
	type Held,
} from "./afk.ts";
import type { WaitingItem, WaitKind } from "./adapter.ts";
import { askQuestion, newItemId, questionStates, QUEUE, type Question } from "./questions.ts";
import type { Store } from "./store.ts";

/** What the engine passes on of one waiting card. The card's questions, options and any value are not part of it. */
export type CardWait = {
	thread: string;
	server: string;
	threadId: string;
	requestId: string;
	type: WaitKind;
	label: string;
};

/** Pure: the fields of a waiting item that may travel. Everything else on it (its questions and options) is dropped here. */
export const cardWaitOf = (
	w: Pick<WaitingItem, "type" | "requestId" | "label">,
	at: { thread: string; server: string; threadId: string },
): CardWait => ({
	thread: at.thread,
	server: at.server,
	threadId: at.threadId,
	requestId: w.requestId,
	type: w.type,
	label: w.label,
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const WHAT: Record<string, { noun: string; tag: string; asks: string; hold: string }> = {
	secret_request: {
		noun: "secret",
		tag: "Secret",
		asks: "a secret (the value is entered in its thread, never here)",
		hold: "secret request",
	},
	link_request: {
		noun: "machine-link approval",
		tag: "Approval",
		asks: "approval to link two machines",
		hold: "approval to link two machines",
	},
	approval_request: {
		noun: "command approval",
		tag: "Approval",
		asks: "approval to run a command or use a permission",
		hold: "command or permission approval",
	},
};
const kindOf = (type: string) => WHAT[type] ?? WHAT.approval_request!;

/** Pure: the hold's one-line text: the card's kind and the adapter's label. */
export const holdText = (w: Pick<CardWait, "type" | "label">) =>
	`${kindOf(w.type).hold}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`;

/** Pure: the pointer question for a card, built from the CardWait fields only. */
export function cardQuestion(w: CardWait, id: string, createdAt: string): Question {
	const k = kindOf(w.type);
	const secret = w.type === "secret_request";
	return {
		id,
		kind: "only-you",
		title: `${clip(flat(w.thread), 60)} waits on your ${k.noun}`,
		context: [
			`- Thread: ${clip(flat(w.thread), 120)} (on ${flat(w.server)})`,
			`- It asks for: ${k.asks}${w.label ? `: ${clip(flat(w.label), 100)}` : ""}`,
			"- Act on the question card itself, in its thread. This question and its hold close only when the card does; answering here closes nothing.",
			...(secret ? ["- The value never goes through this queue."] : []),
		].join("\n"),
		// Neither option says the card was handled: the page refuses an answer to a pointer, and only the card resolving closes it.
		options: [{ label: "Open the question card in its thread" }, { label: "Leave the question card waiting" }],
		thread: clip(flat(w.thread), 80),
		server: w.server,
		threadId: w.threadId,
		tag: k.tag,
		...(secret ? { secret: true } : {}),
		cardRequest: w.requestId,
		notSettled: "a pending card is a live request, not a settled question",
		createdAt,
	};
}

/** The open question that points to this card, if one was filed. */
export function questionForCard(store: Store, server: string, requestId: string): string | undefined {
	for (const q of questionStates(store).values())
		if (q.status === "open" && q.cardRequest === requestId && q.server === server) return q.id;
	return undefined;
}

/**
 * Hold a card for the operator, behind its pointer question, in one transaction (nested in the caller's when there is one).
 * Idempotent per card: an open hold or question for the same server and request is reused. Returns the question, whether it
 * was filed now (`filed`: the caller may post it) and whether a hold was written now (`held`).
 */
export function holdCard(
	store: Store,
	w: CardWait,
	now = new Date(),
	newId: () => string = newItemId,
): { item: string; question?: Question; filed: boolean; held: boolean } {
	return store.tx(() => {
		let item = questionForCard(store, w.server, w.requestId);
		let question: Question | undefined;
		if (!item) {
			question = cardQuestion(w, newId(), now.toISOString());
			askQuestion(store, question, now.getTime());
			item = question.id;
		}
		if (heldOpen(store).some((h) => sameCard(cardRefOf(h), w)))
			return { item, ...(question ? { question } : {}), filed: Boolean(question), held: false };
		// The sequence value the hold is written with: only a read started with a greater value may close it.
		appendHeld(
			store,
			{
				thread: clip(w.thread, 80),
				server: w.server,
				requestId: w.requestId,
				what: holdText(w),
				taken: "left parked",
				item,
				card: { server: w.server, threadId: w.threadId, requestId: w.requestId },
				seq: store.sequence.next(),
			},
			now,
		);
		return { item, ...(question ? { question } : {}), filed: Boolean(question), held: true };
	});
}

const sameCard = (a: Pick<CardRef, "server" | "requestId"> | undefined, b: Pick<CardRef, "server" | "requestId">) =>
	a !== undefined && a.server === b.server && a.requestId === b.requestId;
/** Pure: a hold's card as far as the hold itself says (its `card`, or the server and request ID an older hold carries). */
const cardRefOf = (h: Held): (Partial<CardRef> & Pick<CardRef, "server" | "requestId">) | undefined =>
	h.card ?? (isCardHold(h) && h.server && h.requestId ? { server: h.server, requestId: h.requestId } : undefined);

/** The card left its thread (answered or withdrawn there): its open pointer questions close with it, as answered on the card. */
export function closeCardQuestions(store: Store, server: string, requestId: string, now = Date.now()): number {
	return store.tx(() => {
		let n = 0;
		for (const q of questionStates(store).values()) {
			if (q.status !== "open" || q.cardRequest !== requestId || q.server !== server) continue;
			store.items.resolve(QUEUE, q.id, now, { answeredOnCard: true });
			n++;
		}
		return n;
	});
}

/**
 * The card (server, request ID) resolved or vanished: its open pointer questions close as answered on the card, its open card
 * holds close, and so do the Steward's holds that name its thread, all in ONE transaction, so a card hold never closes without
 * its pointer question or the other way round. This is the only code that closes a card hold. Idempotent: a second call closes nothing.
 */
export function closeCard(
	store: Store,
	c: Pick<CardRef, "server" | "requestId"> & { threadId?: string },
	how: string,
	now = new Date(),
	writtenBefore?: number,
): { questions: number; holds: number } {
	return store.tx(() => {
		// With `writtenBefore` (a read's sequence value), the card closes only when it has an open hold and EVERY open hold of it
		// was written with a smaller value, judged on the holds as they are NOW, inside this transaction; otherwise nothing closes.
		// So a hold written while the read was out stays, with its question, and a hold never closes without its question.
		if (writtenBefore !== undefined) {
			const mine = heldOpen(store).filter((h) => sameCard(cardRefOf(h), c));
			if (!mine.length || !mine.every((h) => typeof h.seq === "number" && h.seq < writtenBefore))
				return { questions: 0, holds: 0 };
		}
		const cards = closeHeldWhere(store, (h) => (sameCard(cardRefOf(h), c) ? how : undefined), now);
		const questions = closeCardQuestions(store, c.server, c.requestId, now.getTime());
		// A closed card is no longer unverifiable, and its alarm (if one was raised) is over.
		store.items.resolve(CARD_UNVERIFIED, cardKey(c), now.getTime());
		store.items.resolve("alarm", cardAlarmKey(c), now.getTime());
		return { questions, holds: cards + (c.threadId ? closeHeldForCard(store, c.server, c.threadId, how) : 0) };
	});
}

/**
 * The operator closes a card by hand: the one way out for a card with no terminal evidence (its thread gone, its item out of the read's window, its reads failing).
 * Closes its pointer question and every open hold of it, in one transaction, like `closeCard`. Throws when nothing of that
 * card is open. The thread, when the hold or question knows it, lets the Steward's holds naming it close too.
 */
export function closeCardByHand(
	store: Store,
	server: string,
	requestId: string,
	how: string,
	now = new Date(),
): { questions: number; holds: number } {
	return store.tx(() => {
		const c = openCards(store).find((x) => x.server === server && x.requestId === requestId);
		if (!c) throw Error(`no open card hold or question for ${server} request ${requestId}`);
		return closeCard(
			store,
			{ server, requestId, ...(c.threadId ? { threadId: c.threadId } : {}) },
			`${how} (closed by hand)`,
			now,
		);
	});
}

/**
 * What a read of one thread on one server says of its cards. `ok: true`: the request IDs it saw waiting, and those whose own
 * item it saw in a terminal status (`resolved`, the only closing evidence). It need not list every card of the thread. `ok: false`
 * is anything else (the server down or not connected, a failed or malformed read): nothing is known, and nothing closes.
 */
export type CardThreadRead =
	| { ok: true; waiting: ReadonlySet<string>; resolved: ReadonlySet<string> }
	| { ok: false; reason: string };

/**
 * An open card, keyed by (server, request ID). `threadId` is undefined when neither its hold nor its question says it.
 * `holds` are its open holds: their handles (afk.ts `heldId`) and the sequence value each was written with (none for a hold
 * written before the sequence existed: such a hold is never closed by a read, only by hand).
 */
export type OpenCard = Pick<CardRef, "server" | "requestId"> & {
	threadId?: string;
	holds: { id: string; seq?: number }[];
};

/** The item source that records since when a card has had no evidence (its `firstSeen`), and the card's key in it. */
export const CARD_UNVERIFIED = "card-unverified";
export const cardKey = (c: Pick<CardRef, "server" | "requestId">) => `${c.server}\u0000${c.requestId}`;
/** The engine's alarm key for a card with no evidence for too long. */
export const cardAlarmKey = (c: Pick<CardRef, "server" | "requestId">) => `card-unverified:${c.server}:${c.requestId}`;

/**
 * Every open card hold and every open pointer question, as the cards they wait on, keyed by (server, request ID). The card's
 * thread comes from the hold's `card`, else from its pointer question (a hold written before `card` existed). A card whose
 * thread cannot be told is listed with no `threadId`: it is never read, so it closes only by hand. Every card hold names its
 * server (`holdCard` writes it, and an entry with none is not a card here), so no card is ever resolved across servers.
 */
export function openCards(store: Store): OpenCard[] {
	const out = new Map<string, OpenCard>();
	const qs = questionStates(store);
	const add = (c: Partial<CardRef>, hold?: { id: string; seq?: number }) => {
		if (!c.server || !c.requestId) return;
		const key = cardKey({ server: c.server, requestId: c.requestId });
		const prev = out.get(key);
		const threadId = prev?.threadId ?? c.threadId;
		out.set(key, {
			server: c.server,
			requestId: c.requestId,
			...(threadId ? { threadId } : {}),
			holds: [...(prev?.holds ?? []), ...(hold ? [hold] : [])],
		});
	};
	for (const q of qs.values())
		if (q.status === "open" && q.cardRequest) add({ server: q.server, threadId: q.threadId, requestId: q.cardRequest });
	for (const h of heldOpen(store)) {
		const c = cardRefOf(h);
		if (!c) continue;
		const q = h.item ? qs.get(h.item) : undefined;
		const seq = typeof h.seq === "number" && Number.isSafeInteger(h.seq) && h.seq > 0 ? h.seq : undefined;
		add(
			{
				...c,
				threadId: c.threadId ?? (q?.cardRequest === c.requestId && q.server === c.server ? q.threadId : undefined),
			},
			{ id: heldId(h), ...(seq ? { seq } : {}) },
		);
	}
	return [...out.values()];
}

/** A card the reconciler found no closing evidence for this pass, and why. */
export type Unverified = { card: OpenCard; reason: string };
export type CardReconcile = {
	closed: CardRef[];
	verified: OpenCard[];
	unverified: Unverified[];
	failed: { server: string; reason: string }[];
};

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
	const cards = openCards(store);
	const reads = new Map<string, { seq: number; r: CardThreadRead }>();
	const out: CardReconcile = { closed: [], verified: [], unverified: [], failed: [] };
	for (const c of cards) {
		if (!c.threadId) {
			out.unverified.push({ card: c, reason: "neither its hold nor its question names its thread" });
			continue;
		}
		const key = `${c.server}\u0000${c.threadId}`;
		let got = reads.get(key);
		if (!got) {
			// Taken before the read is asked for: every hold written with a smaller value was committed before the read started.
			const seq = store.sequence.next();
			const r = await read(c.server, c.threadId).then(
				(x) =>
					isCardThreadRead(x)
						? x
						: ({ ok: false, reason: "the read did not keep the CardThreadRead contract" } as CardThreadRead),
				(e): CardThreadRead => ({ ok: false, reason: String(e instanceof Error ? e.message : e).slice(0, 200) }),
			);
			got = { seq, r };
			reads.set(key, got);
			if (!r.ok) out.failed.push({ server: c.server, reason: r.reason });
		}
		const { seq, r } = got;
		if (!r.ok) {
			out.unverified.push({ card: c, reason: r.reason });
			continue;
		}
		if (r.waiting.has(c.requestId)) {
			out.verified.push(c);
			continue;
		}
		if (!r.resolved.has(c.requestId)) {
			out.unverified.push({
				card: c,
				reason:
					"its thread's read does not show the card resolved or waiting (it may be outside the read's history window)",
			});
			continue;
		}
		if (!c.holds.length || !c.holds.every((h) => h.seq !== undefined && h.seq < seq)) {
			out.unverified.push({
				card: c,
				reason: c.holds.length
					? "the read did not start after its hold was written"
					: "it has no open hold, only its pointer question",
			});
			continue;
		}
		const n = closeCard(
			store,
			{ server: c.server, threadId: c.threadId, requestId: c.requestId },
			"The card's own item is resolved in its thread (completed, cancelled, failed or interrupted there); closed by the daemon's card reconciler.",
			now(),
			seq,
		);
		if (n.questions || n.holds) out.closed.push({ server: c.server, threadId: c.threadId, requestId: c.requestId });
		else out.unverified.push({ card: c, reason: "the read did not start after its hold was written" });
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

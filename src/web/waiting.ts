/**
 * Everything waiting on the operator, across every server, for the decision-queue page and its title. This layer is
 * backend-agnostic: it asks each server's adapter for its waiting cards (`listWaiting`), remembers which servers could
 * not be read, and answers a card through that server's adapter (`answer`) at most once per card as shown. What a card
 * is and how to answer it live in the adapter; a server whose adapter has neither capability is simply not mirrored,
 * and a card it can list but not answer is shown read-only.
 */
import type { Adapter, WaitingCard } from "../core/adapter.ts";
import { has } from "../core/adapter.ts";
import { releaseCardAnswer, reserveCardAnswer, settleCardAnswer } from "../core/card-answers.ts";
import type { ServerEntry } from "../core/servers.ts";
import type { Store } from "../core/store.ts";
import { within } from "../core/within.ts";

/** One configured server and the adapter that serves it. */
export type ServerAdapter = { server: ServerEntry; adapter: Adapter };

/** Names that can never carry answer rights, even as an explicit entry: object built-ins. */
export const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Pure: the servers with answer rights only where web.json grants them: the server named `decisionsServer` (matched by
 * its `origin`), and any server named in `answerTokens`. An operateTokenFile in servers.json itself is always dropped,
 * so the page's rights are visible in one file.
 */
export function withAnswerRights<S extends { name: string; origin?: unknown }>(
	list: S[],
	qs?: { origin: string; operateTokenFile: string },
	answerTokens: Record<string, string> = {},
): (S & { operateTokenFile: string | null })[] {
	const grant = (name: string): string | null => {
		if (RESERVED_NAMES.has(name) || !Object.hasOwn(answerTokens, name)) return null;
		const token = answerTokens[name];
		return typeof token === "string" ? token : null;
	};
	return list.map((s) => ({
		...s,
		operateTokenFile: qs && s.origin === qs.origin ? qs.operateTokenFile : grant(s.name),
	}));
}

/** A call that hasn't answered by then fails, so one hung server can't stall the poll. */
export const POLL_TIMEOUT_MS = 90_000;
/**
 * Pure: the checks every card answer meets, in the order they are told: the card is still listed, it is an answerable kind (a
 * secret or link request never is, whatever it claims), the choice is one of its options, and the fingerprint is the one the operator
 * saw. The confirm step and the answer both run it.
 */
export function checkCard(
	card: WaitingCard | undefined,
	choice: unknown,
	sig: unknown,
):
	| { ok: true; card: WaitingCard; choice: number; sig: string }
	| { ok: false; status: number; body: Record<string, unknown> } {
	if (!card) return { ok: false, status: 404, body: { error: "no such card (answered or withdrawn in its thread?)" } };
	if (!card.answerable || (card.type !== "question" && card.type !== "approval" && card.type !== "goal"))
		return { ok: false, status: 403, body: { error: card.why ?? "answer it in its thread" } };
	if (!Number.isInteger(choice) || (choice as number) < 0 || (choice as number) >= card.options.length)
		return { ok: false, status: 400, body: { error: "choice must be an option index" } };
	if (typeof sig !== "string" || sig !== card.sig)
		return { ok: false, status: 409, body: { error: "the card changed since you saw it: refresh and answer again" } };
	return { ok: true, card, choice: choice as number, sig };
}
/** An approval or a goal proposal cannot be taken back, so answering one takes a server-issued confirmation (src/core/challenge.ts). A question card does not. */
export const needsConfirmation = (card: WaitingCard): boolean => card.type === "approval" || card.type === "goal";

export type WaitingDeps = {
	/** The database a card's one answer is recorded in, shared with every other page process. */
	store: Store;
	/** The servers and their adapters, read fresh on every poll. */
	servers: () => ServerAdapter[];
	/** Threads never listed: the Decisions thread. */
	skipThreads: () => string[];
	/** Server name -> the base a thread id is appended to for an "open in the backend" link. */
	links?: Record<string, string>;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** The longest one server's read may take; tests shorten it. */
	timeoutMs?: number;
};

/** What the waiting layer remembers between polls. */
type WaitingState = {
	byServer: Map<string, WaitingCard[]>;
	/** server -> when it was first found unreachable (a sleeping laptop), cleared when a read succeeds again. */
	failing: Map<string, string>;
};
type AnswerReply = { status: number; body: Record<string, unknown> };

/** An adapter that can list but not answer shows its cards read-only, whatever it says about them. */
const readOnlyCards = (cards: WaitingCard[], serverName: string): WaitingCard[] =>
	cards.map((c) => ({
		...c,
		answerable: false,
		options: c.type === "approval" || c.type === "goal" ? [] : c.options,
		why: c.why ?? `answer it in its thread on ${serverName}`,
	}));

/** Reads one server's cards. A server that can't be read keeps its last cards, and is logged once per outage. */
async function pollServer(d: WaitingDeps, st: WaitingState, skipThreads: string[], { server, adapter }: ServerAdapter) {
	if (!has(adapter, "listWaiting")) return;
	try {
		const cards = await within(
			adapter.listWaiting({ skipThreads, ...(d.links?.[server.name] ? { linkBase: d.links[server.name] } : {}) }),
			d.timeoutMs ?? POLL_TIMEOUT_MS,
			"waiting-card read",
		);
		st.byServer.set(server.name, has(adapter, "answer") ? cards : readOnlyCards(cards, server.name));
		if (st.failing.delete(server.name)) d.log("mirror-recovered", { server: server.name });
	} catch (e) {
		if (st.failing.has(server.name)) return;
		d.log("mirror-error", {
			server: server.name,
			error: String(e instanceof Error ? e.message : e).slice(0, 200),
		});
		st.failing.set(server.name, new Date().toISOString());
	}
}

/** The HTTP status for an adapter's refusal of an answer. */
const failureStatus = (kind: string | undefined): number => (kind === "stale" ? 409 : kind === "refused" ? 403 : 502);

/**
 * Sends a reserved answer and settles the reservation. Kept (the answer may have been sent): settled, so it is never sent
 * again. Otherwise it was certainly not sent: released.
 */
async function sendReserved(
	d: WaitingDeps,
	st: WaitingState,
	adapter: Adapter & Required<Pick<Adapter, "answer">>,
	card: WaitingCard,
	choice: number,
	sig: string,
): Promise<AnswerReply> {
	const drop = () =>
		st.byServer.set(
			card.server,
			(st.byServer.get(card.server) ?? []).filter((c) => c.id !== card.id),
		);
	let settled: "sent" | "maybe-sent" | undefined;
	try {
		const out = await adapter.answer(card, choice, sig);
		if (out.ok) {
			settled = "sent";
			drop();
			return { status: 200, body: { ok: true, choice: out.choice } };
		}
		if (out.maybeSent) settled = "maybe-sent";
		if (out.gone) drop();
		return { status: failureStatus(out.kind), body: { error: out.error } };
	} catch (e) {
		// An adapter that throws instead of reporting may have sent it: the card is not sent twice from here.
		settled = "maybe-sent";
		const error = String(e instanceof Error ? e.message : e).slice(0, 200);
		d.log("mirror-answer-error", { id: card.id, server: card.server, error });
		return { status: 502, body: { error: `could not reach ${card.server}: ${error}` } };
	} finally {
		if (settled) settleCardAnswer(d.store, card.id, sig, { outcome: settled });
		else releaseCardAnswer(d.store, card.id, sig);
	}
}

/**
 * Answers a listed card with one of its options. The checks here are the core's: the card is still listed, it is an
 * answerable kind, the choice is one of its options, the fingerprint is the one the operator saw, and this card as
 * shown has not been sent already. Re-reading it live and sending the answer is the adapter's.
 */
async function answerCard(
	d: WaitingDeps,
	st: WaitingState,
	id: string,
	choice: unknown,
	sig: unknown,
): Promise<AnswerReply> {
	const checked = checkCard(
		[...st.byServer.values()].flat().find((c) => c.id === id),
		choice,
		sig,
	);
	if (!checked.ok) return { status: checked.status, body: checked.body };
	const card = checked.card;
	const pair = d.servers().find((x) => x.server.name === card.server);
	if (!pair || !has(pair.adapter, "answer"))
		return { status: 403, body: { error: `answer it in its thread on ${card.server}` } };
	// Reserve the answer now, before any await, in the database: two answers to one card arriving together, from this process or another,
	// must not both pass. A send whose reply was lost (a timeout) may still land in the backend, so the same card as shown is never
	// sent twice from here (src/core/card-answers.ts); the adapter's fixed command IDs also let it drop a repeat.
	if (!reserveCardAnswer(d.store, { cardId: card.id, sig: checked.sig, choice: checked.choice }))
		return { status: 409, body: { error: "this answer was already sent; check its thread before answering again" } };
	return sendReserved(d, st, pair.adapter, card, checked.choice, checked.sig);
}

export function createWaiting(d: WaitingDeps) {
	const st: WaitingState = { byServer: new Map(), failing: new Map() };
	let polling = false;

	/**
	 * Reads every server once. A server that can't be read keeps its last cards, so a sleeping laptop doesn't empty the list.
	 * Every read has a deadline, and a poll still running when the next tick comes is not doubled.
	 */
	async function poll() {
		if (polling) return;
		polling = true;
		try {
			const skipThreads = d.skipThreads();
			for (const pair of d.servers()) await pollServer(d, st, skipThreads, pair);
		} finally {
			polling = false;
		}
	}

	const list = () => [...st.byServer.values()].flat();
	/** Servers whose last read failed, so the view can say its list may be missing what waits there. */
	const unreachable = () => [...st.failing].map(([server, since]) => ({ server, since }));
	const answer = (id: string, choice: unknown, sig: unknown) => answerCard(d, st, id, choice, sig);

	return { poll, list, answer, unreachable };
}
export type Waiting = ReturnType<typeof createWaiting>;

/** Sends one message to a thread. `seed` fixes its command and message IDs, so a backend can drop a repeat of the same send. */
export type SendToThread = (
	server: string,
	threadId: string,
	text: string,
	seed: string,
) => Promise<{ ok: boolean; detail: string }>;
/**
 * The page's way to send a message into a thread, through the adapter of the server it belongs to. A server whose adapter
 * has no `send` is refused, and the caller falls back to waking the Steward.
 */
export function threadSender(servers: () => ServerAdapter[]): SendToThread {
	return async (server, threadId, text, seed) => {
		const pair = servers().find((x) => x.server.name === server);
		if (!pair) return { ok: false, detail: `no server named ${server} in servers.json` };
		if (!has(pair.adapter, "send"))
			return {
				ok: false,
				detail: `${server}'s adapter (${pair.adapter.id}) cannot send to threads, so the page can't send to them`,
			};
		return pair.adapter.send(threadId, text, seed);
	};
}

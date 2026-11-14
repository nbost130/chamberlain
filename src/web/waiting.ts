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
	const grant = (name: string) =>
		!RESERVED_NAMES.has(name) && Object.hasOwn(answerTokens, name) && typeof answerTokens[name] === "string"
			? answerTokens[name]!
			: null;
	return list.map((s) => ({
		...s,
		operateTokenFile: qs && s.origin === qs.origin ? qs.operateTokenFile : grant(s.name),
	}));
}

/** A call that hasn't answered by then fails, so one hung server can't stall the poll. */
export const POLL_TIMEOUT_MS = 90_000;
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(Error(`${what} timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

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
	/** The clock a read's start is taken from (`secretRequest` compares it with a question's age). Default Date.now; tests move it. */
	now?: () => number;
};

/** What `secretRequest` is asked about: a secret question's thread, the card it points to (if any) and when it was asked. */
export type SecretAsk = { server: string; threadId?: string; cardRequest?: string; createdAt: string };

export function createWaiting(d: WaitingDeps) {
	const byServer = new Map<string, WaitingCard[]>();
	/** server -> when it was first found unreachable (a sleeping laptop), cleared when a read succeeds again. */
	const failing = new Map<string, string>();
	/** server -> when its last read that succeeded STARTED (ms): only a read begun after a question can say its box is gone. */
	const readAt = new Map<string, number>();
	const now = d.now ?? Date.now;
	let polling = false;

	/**
	 * Reads every server once. A server that can't be read keeps its last cards, so a sleeping laptop doesn't empty the list.
	 * Every read has a deadline, and a poll still running when the next tick comes is not doubled.
	 */
	async function poll() {
		if (polling) return;
		polling = true;
		try {
			await pollAll();
		} finally {
			polling = false;
		}
	}

	async function pollAll() {
		const skipThreads = d.skipThreads();
		for (const { server, adapter } of d.servers()) {
			if (!has(adapter, "listWaiting")) continue;
			const started = now();
			try {
				const cards = await within(
					adapter.listWaiting({ skipThreads, ...(d.links?.[server.name] ? { linkBase: d.links[server.name] } : {}) }),
					d.timeoutMs ?? POLL_TIMEOUT_MS,
					"waiting-card read",
				);
				// An adapter that can list but not answer shows its cards read-only, whatever it says about them.
				byServer.set(
					server.name,
					has(adapter, "answer")
						? cards
						: cards.map((c) => ({
								...c,
								answerable: false,
								options: c.type === "approval" || c.type === "goal" ? [] : c.options,
								why: c.why ?? `answer it in its thread on ${server.name}`,
							})),
				);
				readAt.set(server.name, started);
				if (failing.delete(server.name)) d.log("mirror-recovered", { server: server.name });
			} catch (e) {
				if (!failing.has(server.name))
					d.log("mirror-error", {
						server: server.name,
						error: String(e instanceof Error ? e.message : e).slice(0, 200),
					});
				if (!failing.has(server.name)) failing.set(server.name, new Date().toISOString());
			}
		}
	}

	const list = () => [...byServer.values()].flat();
	/** Servers whose last read failed, so the view can say its list may be missing what waits there. */
	const unreachable = () => [...failing].map(([server, since]) => ({ server, since }));

	/**
	 * Is the secret box a secret question points at still open in its thread? Read from what `listWaiting` lists, which for a secret is
	 * the backend's own word that the box waits on the operator now (T3 lists a secret request only while it is pending and the agent that
	 * asked is still waiting on it; a box that timed out, was cancelled, declined or saved is not listed).
	 *   - `open`: the thread lists a waiting secret request (the question's own card, when it points to one).
	 *   - `ended`: it lists none, by a read of that server that succeeded and STARTED after the question was asked.
	 *   - undefined: the reads cannot tell: no thread on the question, a server not mirrored, not yet read since the question was asked, or
	 *     unreachable now; or the thread is one the mirror never lists (the Decisions thread). The card then says what it always said.
	 * This only labels a card. It closes nothing: a card hold still closes only on its own terminal evidence (src/core/card-hold.ts).
	 */
	function secretRequest(q: SecretAsk): "open" | "ended" | undefined {
		if (!q.threadId) return undefined;
		const at = readAt.get(q.server);
		const asked = Date.parse(q.createdAt);
		if (at === undefined || failing.has(q.server) || !Number.isFinite(asked) || at <= asked) return undefined;
		if (d.skipThreads().includes(q.threadId)) return undefined;
		const waits = (byServer.get(q.server) ?? []).some(
			(c) =>
				c.type === "secret" &&
				c.server === q.server &&
				c.threadId === q.threadId &&
				(!q.cardRequest || c.requestId === q.cardRequest),
		);
		return waits ? "open" : "ended";
	}

	/**
	 * Answers a listed card with one of its options. The checks here are the core's: the card is still listed, it is an
	 * answerable kind, the choice is one of its options, the fingerprint is the one the operator saw, and this card as
	 * shown has not been sent already. Re-reading it live and sending the answer is the adapter's.
	 */
	async function answer(
		id: string,
		choice: unknown,
		sig: unknown,
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const checked = checkCard(
			list().find((c) => c.id === id),
			choice,
			sig,
		);
		if (!checked.ok) return { status: checked.status, body: checked.body };
		const card = checked.card;
		const pair = d.servers().find((x) => x.server.name === card.server);
		if (!pair || !has(pair.adapter, "answer"))
			return { status: 403, body: { error: `answer it in its thread on ${card.server}` } };
		const drop = () =>
			byServer.set(
				card.server,
				(byServer.get(card.server) ?? []).filter((c) => c.id !== id),
			);
		// Reserve the answer now, before any await, in the database: two answers to one card arriving together, from this process or another,
		// must not both pass. A send whose reply was lost (a timeout) may still land in the backend, so the same card as shown is never
		// sent twice from here (src/core/card-answers.ts); the adapter's fixed command IDs also let it drop a repeat.
		if (!reserveCardAnswer(d.store, { cardId: card.id, sig: checked.sig, choice: checked.choice }))
			return { status: 409, body: { error: "this answer was already sent; check its thread before answering again" } };
		let settled: "sent" | "maybe-sent" | undefined;
		try {
			const out = await pair.adapter.answer(card, checked.choice, checked.sig);
			if (out.ok) {
				settled = "sent";
				drop();
				return { status: 200, body: { ok: true, choice: out.choice } };
			}
			if (out.maybeSent) settled = "maybe-sent";
			if (out.gone) drop();
			return { status: out.kind === "stale" ? 409 : out.kind === "refused" ? 403 : 502, body: { error: out.error } };
		} catch (e) {
			// An adapter that throws instead of reporting may have sent it: the card is not sent twice from here.
			settled = "maybe-sent";
			const error = String(e instanceof Error ? e.message : e).slice(0, 200);
			d.log("mirror-answer-error", { id, server: card.server, error });
			return { status: 502, body: { error: `could not reach ${card.server}: ${error}` } };
		} finally {
			// Kept (the answer may have been sent): settled, so it is never sent again. Otherwise it was certainly not sent: released.
			if (settled) settleCardAnswer(d.store, card.id, checked.sig, { outcome: settled });
			else releaseCardAnswer(d.store, card.id, checked.sig);
		}
	}

	return { poll, list, answer, unreachable, secretRequest };
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

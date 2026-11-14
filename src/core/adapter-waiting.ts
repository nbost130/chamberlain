/** The adapter contract for cards waiting on the operator: what a thread waits on, a card as the page shows it, and an answer's outcome. */

/** The kinds of waiting item. An adapter maps its own names onto these (T3 calls a link request by several names). */
export type WaitKind = "user_input_request" | "approval_request" | "secret_request" | "link_request";
export type WaitQuestion = { question?: string; options?: { label?: string; description?: string }[] };
/** One thing a thread is waiting on: a question, an approval, a secret or a link request. */
export type WaitingItem = { type: WaitKind; requestId: string; label: string; questions: WaitQuestion[] };

/**
 * A read of one thread's cards. `ok: true`: the backend was connected for the whole read and answered in the shape the adapter
 * expects. It is NOT a complete list of the thread's cards: a backend may return a bounded window of the thread's history (T3
 * does), so a card missing from it says nothing about that card.
 *   - `cards`: the cards seen waiting now, for the wake path.
 *   - `resolved`: request IDs of cards whose OWN item the read saw in a terminal status (resolved: answered, declined,
 *     cancelled, failed or interrupted). This is the ONLY evidence that closes a card hold (card-hold.ts). An adapter that
 *     cannot tell leaves it out, and its card holds close only by hand.
 *   - `ignored`: why a card item was skipped (a missing or invalid request ID or status, an unknown status, two items of one
 *     card that disagree). A skipped item is never evidence of anything; the core logs the reasons.
 * Everything else is `ok: false` with a reason: a server that is down or not connected now (a `mayBeOffline` server asleep
 * included), a thread the backend cannot find, any error, an answer in a shape the adapter does not expect. `waiting` never rejects.
 */
export type WaitingRead =
	| { ok: true; cards: WaitingItem[]; resolved?: string[]; ignored?: string[] }
	| { ok: false; reason: string };

/** Pure: does a value from an adapter keep the `WaitingRead` contract? The core treats anything else as `ok: false`. */
export function isWaitingRead(r: unknown): r is WaitingRead {
	if (!r || typeof r !== "object") return false;
	const o = r as Record<string, unknown>;
	if (o.ok === false) return typeof o.reason === "string";
	const strings = (v: unknown) =>
		v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string" && x !== ""));
	return (
		o.ok === true &&
		Array.isArray(o.cards) &&
		strings(o.resolved) &&
		strings(o.ignored) &&
		o.cards.every(
			(c) =>
				!!c &&
				typeof c === "object" &&
				typeof (c as WaitingItem).requestId === "string" &&
				(c as WaitingItem).requestId !== "" &&
				typeof (c as WaitingItem).type === "string",
		)
	);
}

/** A question, approval, secret, link request or goal proposal waiting on the operator in some thread. */
export type WaitingCard = {
	id: string;
	/** A question card, or one of the kinds that are only ever shown. */
	type: "question" | "approval" | "secret" | "link" | "goal";
	server: string;
	threadId: string;
	threadTitle: string;
	requestId: string;
	header?: string;
	question: string;
	options: { label: string; detail?: string }[];
	recommended?: number;
	/** True when the operator can answer it from the page; otherwise `why` says where to answer it. */
	answerable: boolean;
	why?: string;
	link?: string;
	/** An approval's command, or a proposal's text, exactly as the backend holds it (shown verbatim, never reflowed). */
	command?: string;
	/** Fingerprint of the card exactly as the backend holds it. An answer must carry the one the operator saw. */
	sig: string;
};

/**
 * Links to one thread on one server. Each is absent when it cannot be made exactly (the backend has not said which environment
 * the server is, say): no link is better than one that opens the wrong thread or nothing.
 */
export type ThreadLinks = {
	/**
	 * The backend's own reference to the thread, as its messages write one (T3: `t3-thread://v2/<environmentId>/<threadId>`).
	 * It opens inside the backend's own client, where it is written in a message; a browser or a phone's OS does not know it.
	 */
	ref?: string;
	/**
	 * A link a phone or computer hands to the backend's app to open the thread there (T3: `t3code://threads/<environmentId>/<threadId>`).
	 * The page sends a device to it through its own http(s) route, `/open/<server>/<threadId>`: an embedded frame may open only http(s).
	 */
	app?: string;
};

export type ListWaitingOptions = {
	/** Threads never listed (the Decisions thread). */
	skipThreads: string[];
	/** Prefix a thread id is appended to for an "open in the backend" link. */
	linkBase?: string;
};

/**
 * How an answer to a card ended. `stale`: the card changed or went away before anything was sent. `refused`: this
 * adapter may not answer (no rights). `unreachable`: the backend could not be reached or did not reply. `maybeSent`
 * means the answer may have reached the backend even though this call failed, so the core never sends it again.
 * `gone` means the card is no longer waiting, so the core drops it from its list.
 */
export type AnswerOutcome =
	| { ok: true; choice: string }
	| { ok: false; kind: "stale" | "refused" | "unreachable"; error: string; maybeSent: boolean; gone?: boolean };

// ---- the steward ---------------------------------------------------------------------------------

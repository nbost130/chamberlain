/**
 * T3's side of the waiting-card mirror (`listWaiting` and `answer` of the adapter contract): reads everything waiting on
 * the operator in one T3 server's threads and answers a card back through T3's own command, after re-reading it. Bounds:
 * - Question cards (`user_input_request`) can be answered here.
 * - Approvals (`approval_request`) can be approved once or declined here. Never "always" or "for this session". The
 *   command is shown exactly as T3 holds it, the answer must carry the fingerprint of what was shown, the view asks for
 *   a confirm tap, and every answer is logged with the full command text.
 * - Secret and link requests are listed read-only with a link to their thread, permanently: never answerable here.
 * - Goal proposals: a thread whose last message is a finished assistant message carrying a fenced `/goal …` block,
 *   with no reply after it and no run going. "Accept goal" sends that exact /goal text to the thread as the
 *   principal's message, the way they accept one by hand.
 * - A card on a server with an operate token can be answered; the answer goes straight to the card in its own thread
 *   through runtime-request.respond. A server without one is shown read-only.
 * - A card carrying a queue item tag ([Q-…]) is left out: those questions are already queue items.
 * What is generic (one list across servers, the unreachable record, one answer per card) lives in src/web/waiting.ts.
 */
import type { ListWaitingOptions } from "../../core/adapter.ts";
import { CALL_TIMEOUT_MS, createRpcPing, openWithin, readToken, within } from "./ping.ts";
import { checkProjection } from "./projection.ts";
import { connect } from "./rpc.ts";
import { answerOn } from "./wait-answer.ts";
import type { MirrorCard } from "./wait-cards.ts";
import type { Ctx, Projected, WaitingDeps } from "./wait-ctx.ts";
import { listWaitingOn } from "./wait-scan.ts";

/**
 * One T3 server's waiting cards: `listWaiting` reads them (and throws, with every token redacted, when the server can't
 * be read), `answer` answers one after re-reading it live, and `send` sends a message into a thread as the Steward.
 */
export function createT3Waiting(d: WaitingDeps) {
	const open = connect as unknown as NonNullable<WaitingDeps["connect"]>;
	const conn = d.connect ?? open;
	const s = d.server;
	const ms = d.timeoutMs ?? CALL_TIMEOUT_MS;
	const ctx: Ctx = {
		d,
		s,
		ms,
		secrets: () => [readToken(d.conf, s.tokenFile), readToken(d.conf, s.operateTokenFile)],
		project: async (rpc, threadId) =>
			checkProjection(
				await within(rpc.request("orchestration.getThreadProjection", { threadId }), ms, "projection read"),
			) as Projected,
		open: (token) => openWithin(conn, s.origin, token, ms),
		goalSeen: new Map(),
	};
	/** The adapter's `send`: the one ping (./ping.ts), signed as the Steward unless the caller names another identity. */
	const send = createRpcPing({ server: s, conf: d.conf, connect: conn, timeoutMs: ms });
	return {
		listWaiting: (o: ListWaitingOptions) => listWaitingOn(ctx, o),
		answer: (card: MirrorCard, choice: number, sig: string) => answerOn(ctx, card, choice, sig),
		send,
	};
}

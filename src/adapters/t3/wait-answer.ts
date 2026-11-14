/** Answering one waiting card through T3's own command, after reading it again live from its thread. */
import type { AnswerOutcome } from "../../core/adapter.ts";
import { messageCommand, readToken, redact, stableId, within } from "./ping.ts";
import {
	approvalCard,
	BUSY,
	type CardScope,
	cardsFrom,
	goalCard,
	goalProposal,
	type MirrorCard,
	type TurnItem,
} from "./wait-cards.ts";
import type { Conn, Ctx, Projected } from "./wait-ctx.ts";

/** The only decisions the page can send for an approval, by option index. Never "always" or "for this session". */
const APPROVAL_DECISIONS = ["accept", "decline"] as const;

/** What one answer attempt did, for the outcome it reports when the call fails: whether a command went out, and whether T3 refused it. */
type Attempt = { dispatched: boolean; refusedByT3: boolean };
/** One answer in flight: the card and the choice, the open socket and what the attempt has done. */
type AnswerJob = { ctx: Ctx; rpc: Conn; attempt: Attempt; card: MirrorCard; choice: number; sig: string; key: string };

const stale = (error: string, gone = false): AnswerOutcome => ({
	ok: false,
	kind: "stale",
	error,
	maybeSent: false,
	...(gone ? { gone } : {}),
});

/** If its reply is lost, the answer may still have delivered. T3 refusing the command (an "rpc failure" reply) means it did not. */
function dispatch(job: AnswerJob, cmd: Record<string, unknown>, what: string) {
	job.attempt.dispatched = true;
	return within(job.rpc.request("orchestration.dispatchCommand", cmd), job.ctx.ms, what).catch((e) => {
		if (String(e).includes("rpc failure")) job.attempt.refusedByT3 = true;
		throw e;
	});
}

/**
 * Answers a card with one of its options, after re-reading it from its thread: it must still be the same waiting
 * card, unchanged since the operator saw it (`sig`), and the server must have an operate token. The core has already
 * checked the choice is an option and the fingerprint is the one it listed. Nothing but a question, an approval or
 * a goal is ever answered here.
 */
export async function answerOn(ctx: Ctx, card: MirrorCard, choice: number, sig: string): Promise<AnswerOutcome> {
	const { d, s } = ctx;
	const token = readToken(d.conf, s.operateTokenFile);
	if (!token)
		return { ok: false, kind: "refused", error: `answer it in its thread on ${card.server}`, maybeSent: false };
	const attempt: Attempt = { dispatched: false, refusedByT3: false };
	try {
		const rpc = await ctx.open(token);
		try {
			return await answerThrough({ ctx, rpc, attempt, card, choice, sig, key: `${card.id}\0${sig}` });
		} finally {
			rpc.ws.close();
		}
	} catch (e) {
		const error = redact(String(e), ctx.secrets()).slice(0, 200);
		d.log("mirror-answer-error", { id: card.id, server: card.server, error });
		return {
			ok: false,
			kind: "unreachable",
			error: `could not reach T3: ${error}`,
			maybeSent: attempt.dispatched && !attempt.refusedByT3,
		};
	}
}

/** The scope a live card is rebuilt in to compare it with the one the principal saw: answerable, no link. */
const answerScope = (card: MirrorCard): CardScope => ({
	server: card.server,
	canAnswer: true,
	thread: { id: card.threadId, title: card.threadTitle },
});

/** The answer over an open socket: the card is read again from its thread, and the kind of card says how it is answered. */
async function answerThrough(job: AnswerJob): Promise<AnswerOutcome> {
	const { ctx, rpc, card } = job;
	const p = await ctx.project(rpc, card.threadId);
	if (card.type === "goal") return answerGoal(job, p);
	const live = (p.turnItems ?? []).find((i) => String(i.requestId ?? "") === card.requestId);
	const want = card.type === "approval" ? "approval_request" : "user_input_request";
	if (!live || live.type !== want || live.status !== "waiting")
		return stale("that card was already answered or withdrawn in its thread", true);
	return card.type === "approval" ? answerApproval(job, live) : answerQuestion(job, live);
}

async function answerGoal(job: AnswerJob, p: Projected): Promise<AnswerOutcome> {
	const { ctx, card, sig, key } = job;
	// Still the same proposal, still the last word in the thread, and nothing running: then send the /goal.
	const live = goalProposal(p.turnItems ?? []);
	const busy = (p.runs ?? []).some((r) => BUSY.has(String(r.status ?? "")));
	if (!live) return stale("that goal was already answered in its thread", true);
	const now = goalCard(answerScope(card), live);
	if (busy || now.sig !== sig || now.sig !== card.sig)
		return stale("the goal changed since you saw it, or the thread is busy: refresh and try again");
	await dispatch(
		job,
		messageCommand({ threadId: card.threadId, text: live.goal, seed: key, identity: "operator", start: true }),
		"send",
	);
	ctx.d.log("mirror-goal-accepted", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		threadTitle: card.threadTitle,
		goal: live.goal,
	});
	return { ok: true, choice: "Goal accepted" };
}

async function answerApproval(job: AnswerJob, live: TurnItem): Promise<AnswerOutcome> {
	const { ctx, card, choice, sig, key } = job;
	// Byte-for-byte: the live approval must give the fingerprint the principal was shown.
	const now = approvalCard(answerScope(card), live);
	if (!now?.answerable || now.sig !== sig || now.sig !== card.sig)
		return stale("the approval changed since you saw it: refresh and answer again");
	const decision = APPROVAL_DECISIONS[choice];
	if (decision === undefined) throw Error(`approval choice ${choice} is not one of ${APPROVAL_DECISIONS.join(", ")}`);
	await dispatch(
		job,
		{
			type: "runtime-request.respond",
			commandId: stableId(`cmd\0${key}`),
			threadId: card.threadId,
			requestId: card.requestId,
			decision,
		},
		"respond",
	);
	ctx.d.log("mirror-approval-answered", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		threadTitle: card.threadTitle,
		requestId: card.requestId,
		decision,
		requestKind: live.requestKind ?? null,
		command: live.prompt ?? null,
		reason: live.reason ?? null,
	});
	return { ok: true, choice: decision === "accept" ? "Approved once" : "Declined" };
}

async function answerQuestion(job: AnswerJob, live: TurnItem): Promise<AnswerOutcome> {
	const { ctx, card, choice, sig, key } = job;
	// The live card must be exactly the one the principal saw: same questions, same options in the same order, still untagged.
	const now = cardsFrom(answerScope(card), [live])[0];
	const q = live.questions?.[0];
	const raw = q?.options?.[choice]?.label;
	const picked = now?.options[choice];
	if (!now?.answerable || now.sig !== sig || !q || raw === undefined || !picked)
		return stale("the card changed since you saw it: refresh and answer again");
	await dispatch(
		job,
		{
			type: "runtime-request.respond",
			commandId: stableId(`cmd\0${key}`),
			threadId: card.threadId,
			requestId: card.requestId,
			answers: { [q.id]: raw },
		},
		"respond",
	);
	ctx.d.log("mirror-answered", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		requestId: card.requestId,
		choice: picked.label,
	});
	return { ok: true, choice: picked.label };
}

/** Answering one queue item (or a batch of them): the checks, the claim, the ruling it saves and the reply. */

import { crashPoint } from "../core/crash.ts";
import { ledgerEvents } from "../core/obs/ledger.ts";
import type { Answer, QuestionState } from "../core/questions.ts";
import { type Claim, claimWake, enqueueClaim, pageClaim, wokenBy } from "../core/questions-claim.ts";
import { answerDeliveryId, batchable } from "../core/questions-wake.ts";
import { recordInForce, stageRulings } from "../core/rulings.ts";
import { expiresProblem, isExpired } from "../core/rulings-expiry.ts";
import { clearSnooze } from "../core/snooze.ts";
import type { Ctx } from "./app-ctx.ts";
import { INLINE_ANSWER_FIELDS } from "./app-http.ts";
import { follow } from "./app-relay.ts";
import { takenReply, unsettleable } from "./queue-actions.ts";

export type AnswerIn = { choice: number; note?: string; saveRuling?: boolean; rulingWording?: string };
type Reply = { status: number; body: unknown };
const refusal = (status: number, error: string): Reply => ({ status, body: { error } });
/** One step of a check that can stop with a reply of its own. */
type Step<T> = { ok: true; value: T } | { ok: false; reply: Reply };
const pass = <T>(value: T): Step<T> => ({ ok: true, value });
const stop = (status: number, error: string): Step<never> => ({ ok: false, reply: refusal(status, error) });

/**
 * An inline frame answers a question with a choice and a note. A ruling field in its request is refused, not ignored, whatever
 * the item or the ticked box would have made of it: only the full page may save a ruling.
 */
function inlineRefusal(body: AnswerIn): Reply | undefined {
	const extra = Object.keys(body).filter((k) => !INLINE_ANSWER_FIELDS.has(k));
	if (extra.length)
		return refusal(
			403,
			`an inline frame may only choose an option and add a note, not ${extra.map((k) => JSON.stringify(k)).join(", ")}: answer on the full page`,
		);
	if (body.note !== undefined && typeof body.note !== "string") return refusal(400, "note must be text");
	return undefined;
}

/** The item an answer is for, when it can still be answered here. */
function answerableItem(ctx: Ctx, id: string): Step<QuestionState> {
	const i = ctx.state().get(id);
	if (!i) return stop(404, "no such item");
	const refused = unsettleable(i);
	return refused ? { ok: false, reply: refused } : pass(i);
}

/** The label of the option chosen, when the choice is one of the item's options. */
function chosenLabel(i: QuestionState, choice: number): Step<string> {
	const option = Number.isInteger(choice) && choice >= 0 ? i.options[choice] : undefined;
	return option ? pass(option.label) : stop(400, "choose one of the options");
}

/** The wording of the ruling this answer saves: none unless it was explicitly ticked on a single answer (a batch never carries one). */
function rulingToSave(ctx: Ctx, i: QuestionState, body: AnswerIn, by: "page" | "batch"): Step<string | undefined> {
	const wantsRuling = body.saveRuling === true && by === "page";
	const decides = wantsRuling
		? (typeof body.rulingWording === "string" && body.rulingWording.trim()) || i.proposedRuling
		: undefined;
	if (wantsRuling && !decides) return stop(400, "there is no ruling wording to save");
	const expiryProblem = decides && i.proposedExpires ? expiresProblem(i.proposedExpires) : undefined;
	if (expiryProblem)
		return stop(400, `the proposed ruling's expiry ${expiryProblem}: save it without a ruling, or write a new one`);
	if (decides && i.proposedExpires && isExpired({ expires: i.proposedExpires }, ctx.clock()))
		return stop(
			400,
			`the proposed ruling expired on ${i.proposedExpires}: save it without a ruling, or write a new one`,
		);
	return pass(decides);
}

/** The ruling an answer saves, recorded in the list in memory: an identical live ruling is that ruling, so saving twice adds nothing. */
function stagedRuling(
	ctx: Ctx,
	i: QuestionState,
	list: Parameters<typeof recordInForce>[0],
	{ decides, how }: { decides: string; how: string },
) {
	return recordInForce(
		list,
		{
			words: how,
			decides: decides.trim(),
			source: "card",
			how: `saved and confirmed by the principal on the queue page, answering ${i.id}`,
			item: i.id,
			opts: i.proposedExpires ? { expires: i.proposedExpires } : undefined,
		},
		ctx.clock(),
	);
}

/**
 * Every refusal comes before the claim, and a refused answer writes nothing. The claim, the answer, the ruling it saves and
 * the wake's outbox row are ONE transaction: they commit together or not at all, so no crash can leave the answer half made.
 * An item whose one wake is already claimed (by an earlier answer, in this process or another) refuses this one.
 */
function claimAnswer(ctx: Ctx, i: QuestionState, base: Answer, decides: string | undefined) {
	const { d } = ctx;
	const made: { claim?: Claim; lost?: Claim } = {};
	d.store.tx(() => {
		// The ruling is saved only once the claim is won, in this same transaction.
		const staged = stageRulings(d.store);
		const how = `${base.label}${base.note ? `. ${base.note}` : ""}`;
		const ruling = decides ? stagedRuling(ctx, i, staged.list, { decides, how }) : undefined;
		const c = pageClaim(i, ruling ? { ...base, ruling: { id: ruling.id, decides: ruling.decides } } : base, ruling);
		const r = claimWake(d.store, c);
		if (!r.won) {
			made.lost = r.claim;
			return;
		}
		if (ruling) staged.commit();
		// Answering a snoozed item (from another surface, or one that returned meanwhile) ends its snooze.
		if (i.snooze) clearSnooze(d.store, i.id);
		// A thread-routed answer's wake is only its fallback: it is written if the direct send fails (follow).
		if (!c.relay) enqueueClaim(d.store, c);
		made.claim = c;
		crashPoint("before-commit");
	});
	return made;
}

/** The reply to an answer that is recorded. The wake is queued for the daemon's relay, which sends it on its next poll. */
function recordedReply(
	ctx: Ctx,
	i: QuestionState,
	claim: Claim,
	{ by, label }: { by: "page" | "batch"; label: string },
): Reply {
	crashPoint("committed");
	const a = claim.answer;
	if (!a) throw Error(`the page's claim on ${i.id} carries no answer`);
	ledgerEvents(ctx.d.store).answered(i.id, a);
	ctx.d.log("answered", { id: i.id, choice: a.choice, by, ruling: a.ruling?.id });
	if (claim.relay) ctx.track(follow(ctx, claim));
	return {
		status: 200,
		body: {
			ok: true,
			id: i.id,
			choice: label,
			ruling: a.ruling?.id,
			to: claim.relay ? "thread" : "steward",
			recorded: true,
			wake: claim.relay ? "thread send started" : "queued",
		},
	};
}

/** Who an answer comes from and how it reached the page: from the page itself or a batch, and from an inline frame or the full page. */
type Via = { by: "page" | "batch"; inline?: boolean };

function answerNow(ctx: Ctx, id: string, body: AnswerIn, { by, inline }: Via): Reply {
	const bad = inline ? inlineRefusal(body) : undefined;
	if (bad) return bad;
	const found = answerableItem(ctx, id);
	if (!found.ok) return found.reply;
	const i = found.value;
	// A batch was decided from a list read before this change got its turn: an item snoozed since is no longer on the active list.
	if (by === "batch" && i.snooze?.active) return refusal(409, "snoozed: it is off the active list");
	const chosen = chosenLabel(i, body.choice);
	if (!chosen.ok) return chosen.reply;
	const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 4000) : undefined;
	const wording = rulingToSave(ctx, i, body, by);
	if (!wording.ok) return wording.reply;
	const held = wokenBy(ctx.d.store, i.id);
	if (held !== undefined) return takenReply(held);
	const base: Answer = {
		choice: body.choice,
		label: chosen.value,
		...(note ? { note } : {}),
		by,
		t: new Date().toISOString(),
		deliveryId: answerDeliveryId(i.id),
	};
	const made = claimAnswer(ctx, i, base, wording.value);
	if (!made.claim) return takenReply(made.lost?.owner ?? "");
	return recordedReply(ctx, i, made.claim, { by, label: chosen.value });
}

/** Records the principal's answer once. A second answer to the same item is refused, so it can never send a second wake. */
export function answer(ctx: Ctx, id: string, body: AnswerIn, via: Via): Promise<Reply> {
	return ctx.serial(() => answerNow(ctx, id, body, via));
}

/** One item of a batch, answered with its recommendation. Undefined when it was answered, else why it was skipped. */
async function acceptOne(ctx: Ctx, id: string): Promise<string | undefined> {
	const i = ctx.state().get(id);
	if (!i) return "no such item";
	if (i.kind === "only-you") return "only you can answer this one";
	if (!batchable(i) || i.recommended === undefined)
		return i.secret ? "a secret" : i.status !== "open" ? "already answered" : "no recommendation";
	const r = await answer(ctx, id, { choice: i.recommended }, { by: "batch" });
	return r.status === 200 ? undefined : String((r.body as { error?: string }).error);
}

export async function acceptAll(ctx: Ctx, ids: unknown): Promise<Reply> {
	if (!Array.isArray(ids)) return refusal(400, "ids must be a list");
	const answered: string[] = [];
	const skipped: { id: string; why: string }[] = [];
	for (const id of ids.map(String)) {
		const why = await acceptOne(ctx, id);
		if (why === undefined) answered.push(id);
		else skipped.push({ id, why });
	}
	return { status: 200, body: { answered, skipped } };
}

// ---- the JSON API -------------------------------------------------------------------------------------

/** The view key's answer to a card waiting in another thread (./view-key.ts `CARD_ANSWER_PATH`): a question card, and nothing else of a card's. */
import type { AppDeps, Ctx } from "./app-ctx.ts";
import { fail, json } from "./app-http.ts";
import { VIEW_KEY_CARD_FIELDS, VIEW_KEY_CARD_TYPES } from "./view-key.ts";
import { needsConfirmation } from "./waiting.ts";

/**
 * A question card only, a choice and the fingerprint only, through the same `mirror.answer` the full page uses (which re-reads the card in its thread
 * and refuses one that changed). No session cookie: the view key never gets one, and a question card needs no confirmation. Recorded as the view key's.
 * An approval, a goal proposal, a secret and a machine link are refused (403) and never sent. The kind is checked twice: here, on the list as the
 * request arrives (an early, logged refusal), and again by `mirror.answer` itself (`only`, ./waiting.ts answerCard) on the card it reserves and sends,
 * so a card replaced under the same id while this request waited its turn is refused there (Sol's audit, 2026-11-15).
 */
export async function viewKeyCardAnswer(
	ctx: Ctx,
	mirror: NonNullable<AppDeps["mirror"]>,
	id: string,
	body: Record<string, unknown>,
): Promise<Response> {
	const { d } = ctx;
	const extra = Object.keys(body).filter((k) => !VIEW_KEY_CARD_FIELDS.has(k));
	if (extra.length)
		return fail(
			403,
			`refused: the key an inline view holds answers a card with a choice only, not ${extra.join(", ")}`,
		);
	const card = mirror.list().find((c) => c.id === id);
	if (!card) return fail(404, "no such card (answered or withdrawn in its thread?)");
	if (!VIEW_KEY_CARD_TYPES.has(card.type) || needsConfirmation(card) || !card.answerable) {
		d.log("card-answer-refused", { id, type: card.type, key: "view" });
		return fail(
			403,
			"refused: approvals, goal proposals, secrets and machine links are never answered with the key an inline view holds",
		);
	}
	const r = await ctx.serial(() => mirror.answer(id, body.choice, body.sig, VIEW_KEY_CARD_TYPES));
	d.log("card-answered", { id, status: r.status, key: "view" });
	return json(r.body, r.status);
}

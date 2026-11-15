/** The JSON API: the three reads, the card routes, the item actions and the ruling routes. */
import type { WaitingCard } from "../core/adapter-waiting.ts";
import {
	CHALLENGE_TTL_MS,
	consumeChallenge,
	issueChallenge,
	newSession,
	SESSION_COOKIE,
	sessionOf,
} from "../core/challenge.ts";
import { type KeyUsed, notNow, type QuestionState } from "../core/questions.ts";
import { ranked, snoozed } from "../core/questions-wake.ts";
import { readRulings } from "../core/rulings.ts";
import { confirmRuling, editRuling, retireRuling } from "../core/rulings-change.ts";
import { isExpired } from "../core/rulings-expiry.ts";
import { citations, inForceNow } from "../core/rulings-read.ts";
import { readHealth } from "../core/steward-health.ts";
import { HEALTH_CONFIG } from "../core/steward-health-config.ts";
import { type AnswerIn, acceptAll, answer } from "./app-answer.ts";
import { type Ctx, cardView, view } from "./app-ctx.ts";
import { fail, json } from "./app-http.ts";
import { ITEM_ACTIONS } from "./queue-actions.ts";
import { type Authority, keyUsed, mayDo } from "./view-key.ts";
import { viewKeyCardAnswer } from "./view-key-cards.ts";
import { checkCard, needsConfirmation } from "./waiting.ts";

function rulingsView(ctx: Ctx) {
	const list = readRulings(ctx.d.store);
	const cites = citations(ctx.d.store.decisions.list());
	return list.map((r) => ({
		...r,
		expired: r.status === "in-force" && isExpired(r, ctx.clock()),
		cited: cites.get(r.id)?.length ?? 0,
		recent: (cites.get(r.id) ?? []).slice(0, 3),
	}));
}

/** The answered and dismissed questions /api/recent shows: the newest twenty. */
function recentStates(states: QuestionState[]): (QuestionState & { at: string })[] {
	const done = states
		.filter((i) => i.status !== "open")
		.map((i) => ({ ...i, at: i.answer?.t ?? i.dismissal?.t ?? i.createdAt }));
	done.sort((a, b) => String(b.at).localeCompare(String(a.at)));
	return done.slice(0, 20);
}

/**
 * The questions the view key's reads show it (/api/queue's open and snoozed lists, /api/recent's twenty), and so the only ones whose listed
 * evidence it may fetch (./app-pages.ts): a file of a question it cannot read is refused to it, whatever the name.
 */
export function viewKeyReadable(ctx: Ctx): Set<string> {
	const states = [...ctx.state().values()];
	return new Set([...ranked(states), ...snoozed(states), ...recentStates(states)].map((i) => i.id));
}

function queueResponse(ctx: Ctx): Response {
	const { d } = ctx;
	// One snapshot for both lists, so an item whose time arrives between two reads is never in neither.
	const states = [...ctx.state().values()];
	const open = ranked(states).map((i) => view(d, i));
	const later = snoozed(states).map((i) => view(d, i));
	const list = readRulings(d.store);
	return json({
		items: open,
		snoozed: later,
		cards: (d.mirror?.list() ?? []).map((c) => cardView(d, c)),
		unreachable: d.mirror?.unreachable?.() ?? [],
		health: readHealth(d.store) ?? null,
		healthLimits: HEALTH_CONFIG,
		inForce: inForceNow(list, ctx.clock()).length,
		unconfirmed: list.filter((r) => r.status !== "retired" && !r.confirmed).length,
		testMode: Boolean(d.testMode),
	});
}

function recentResponse(ctx: Ctx): Response {
	return json({ items: recentStates([...ctx.state().values()]).map((i) => ({ ...view(ctx.d, i), at: i.at })) });
}

/** The GET routes. Undefined for a path that is none of them. */
function apiRead(ctx: Ctx, url: URL, parts: string[]): Response | undefined {
	if (url.pathname === "/api/queue") return queueResponse(ctx);
	if (parts[1] === "items" && parts[2] && parts.length === 3) {
		const i = ctx.state().get(parts[2]);
		return i ? json(view(ctx.d, i)) : fail(404, "no such item");
	}
	if (url.pathname === "/api/rulings") return json({ rulings: rulingsView(ctx) });
	if (url.pathname === "/api/recent") return recentResponse(ctx);
	return undefined;
}

/** The status and message for a confirmation that did not check out. */
function confirmationRefusal(verdict: string): [number, string] {
	if (verdict === "missing") return [428, "this answer needs a confirmation first: ask for one, then confirm"];
	if (verdict === "expired") return [410, "the confirmation expired: confirm again"];
	if (verdict === "used") return [403, "that confirmation was already used: confirm again"];
	return [403, "that confirmation is not for this card, this choice or this session: confirm again"];
}

type CardBody = { choice?: unknown; sig?: unknown; challenge?: unknown };

/** The label of the option a checked card answer chose. checkCard has already refused a choice that is not one of the card's options. */
function cardChoiceLabel(card: WaitingCard, choice: number): string {
	const option = card.options[choice];
	if (!option) throw Error(`checkCard let through choice ${choice} of a card with ${card.options.length} options`);
	return option.label;
}

/** Step one: only a card that needs confirming gets a challenge, and only for what the operator saw and chose. */
function confirmCard(
	ctx: Ctx,
	{ id, card, b }: { id: string; card: WaitingCard | undefined; b: CardBody },
	{ session, withSession }: { session: string; withSession: (r: Response) => Response },
): Response {
	const { d } = ctx;
	const checked = checkCard(card, b.choice, b.sig);
	if (!checked.ok) return json(checked.body, checked.status);
	if (!needsConfirmation(checked.card)) return fail(400, "this card needs no confirmation: answer it directly");
	const { token, expiresAt } = issueChallenge(d.store, {
		cardId: id,
		sig: checked.sig,
		choice: checked.choice,
		session,
		now: d.now?.(),
	});
	const decision = cardChoiceLabel(checked.card, checked.choice);
	d.log("card-confirmation-issued", { id, type: checked.card.type, choice: decision, key: "page" });
	return withSession(json({ ok: true, challenge: token, expiresAt, expiresInMs: CHALLENGE_TTL_MS, decision }));
}

/** Step two. An approval or goal answer without the server's own confirmation is refused, however it was sent. */
function unconfirmedRefusal(
	ctx: Ctx,
	{ id, card, b }: { id: string; card: WaitingCard; b: CardBody },
	session: string,
): Response | undefined {
	const { d } = ctx;
	const verdict =
		b.challenge === undefined
			? "missing"
			: consumeChallenge(d.store, {
					token: b.challenge,
					cardId: id,
					sig: String(b.sig),
					choice: Number(b.choice),
					session,
					now: d.now?.(),
				});
	if (verdict === "ok") return undefined;
	d.log("card-confirmation-refused", { id, type: card.type, verdict, key: "page" });
	const [status, error] = confirmationRefusal(verdict);
	return json({ error, code: `confirmation-${verdict}` }, status);
}

/** One API POST: the request and its URL, the URL's decoded path parts, the parsed JSON body, and who the request is (`Authority`, ./view-key.ts). */
type Call = { req: Request; url: URL; parts: string[]; body: Record<string, unknown>; authority: Authority };

async function cardsRoute(ctx: Ctx, call: Call, id: string, step: "answer" | "confirm"): Promise<Response> {
	const { req, body, authority } = call;
	const { d } = ctx;
	// The view key answers a question card (./view-key.ts) and nothing else here; the page key from a frame or with no Origin answers none.
	// This is the second lock behind the origin and key gates.
	if (authority === "restricted" || (authority === "view" && step !== "answer"))
		return fail(403, "refused: question cards and approvals are answered on the full page, not in an inline frame");
	const { mirror } = d;
	if (!mirror) return fail(404, "not found");
	if (authority === "view") return viewKeyCardAnswer(ctx, mirror, id, body);
	const b = body as CardBody;
	const card = mirror.list().find((c) => c.id === id);
	// The session is a random value in a cookie only this page's own requests carry. It is set when the first challenge is asked for.
	const existing = sessionOf(req.headers.get("cookie"));
	const session = existing ?? newSession();
	const withSession = (r: Response) => {
		if (!existing)
			r.headers.append(
				"set-cookie",
				`${SESSION_COOKIE}=${session}; Path=/api/cards/; HttpOnly; SameSite=Strict; Max-Age=86400`,
			);
		return r;
	};
	if (step === "confirm") return confirmCard(ctx, { id, card, b }, { session, withSession });
	const refused =
		card?.answerable && needsConfirmation(card) ? unconfirmedRefusal(ctx, { id, card, b }, session) : undefined;
	if (refused) return refused;
	const r = await ctx.serial(() => mirror.answer(id, b.choice, b.sig));
	// Only the full page gets here, so the key is the page's own: recorded with the card it answered, whatever the card's own answer was.
	d.log("card-answered", { id, status: r.status, key: keyUsed(authority) });
	return json(r.body, r.status);
}

function notNowRoute(ctx: Ctx, id: string, key: KeyUsed): Promise<Response> {
	return ctx.serial(() => {
		const i = ctx.state().get(id);
		if (i?.status !== "open") return fail(404, "no open item");
		notNow(ctx.d.store, id);
		ctx.d.log("not-now", { id, key });
		return json({ ok: true });
	});
}

/**
 * Snooze, un-snooze, direction and dismiss change state. The full page does all four, and so does the view key (the Snoozed tab's Bring back now
 * is an un-snooze); any other key from a frame or with no Origin none (`mayDo`). The origin and key gates refuse the rest first, and this is the second
 * lock on the same door. The change is recorded with the key it was made with.
 */
function itemActionRoute(ctx: Ctx, id: string, action: string, { body, authority }: Pick<Call, "body" | "authority">) {
	if (!mayDo(authority, action))
		return fail(403, `refused: ${action} is done on the full page, not with the key an inline view holds`);
	return ctx.items.run(id, action, body, keyUsed(authority)).then((r) => json(r.body, r.status));
}

/** The change a ruling action makes. Undefined for an action that is not one. */
function changeRuling(ctx: Ctx, id: string, action: string, decides: string | undefined) {
	const { store } = ctx.d;
	if (action === "confirm") return confirmRuling(store, id, decides, ctx.clock);
	if (action === "edit") return editRuling(store, id, decides ?? "", ctx.clock);
	if (action === "once") return retireRuling(store, id, { how: "only this once" }, ctx.clock);
	if (action === "retire") return retireRuling(store, id, { how: "retired" }, ctx.clock);
	return undefined;
}

function rulingRoute(ctx: Ctx, id: string, action: string, body: Record<string, unknown>): Response {
	const decides = typeof body.decides === "string" ? body.decides : undefined;
	try {
		const r = changeRuling(ctx, id, action, decides);
		if (!r) return fail(404, "unknown action");
		// Only the full page gets here (apiPost), so the key is the page's own.
		ctx.d.log("ruling-changed", { id, action, key: "page" });
		return json({ ok: true, ruling: r });
	} catch (e) {
		return fail(400, String((e as Error).message));
	}
}

const pathParts = (pathname: string) =>
	pathname
		.split("/")
		.filter(Boolean)
		.map((p) => {
			try {
				return decodeURIComponent(p);
			} catch {
				return "\0";
			}
		});

/** The POST routes. `body` is the parsed JSON object. */
async function apiPost(ctx: Ctx, call: Call): Promise<Response> {
	const { url, parts, body, authority } = call;
	if (parts[1] === "cards" && parts[2] && (parts[3] === "answer" || parts[3] === "confirm") && parts.length === 4)
		return cardsRoute(ctx, call, parts[2], parts[3]);
	if (parts[1] === "items" && parts[2] && parts[3] === "answer") {
		const via = {
			by: "page",
			inline: authority !== "full",
			key: keyUsed(authority),
			choiceOnly: authority === "view",
		} as const;
		const r = await answer(ctx, parts[2], body as unknown as AnswerIn, via);
		return json(r.body, r.status);
	}
	if (parts[1] === "items" && parts[2] && parts.length === 4 && ITEM_ACTIONS.has(String(parts[3])))
		return itemActionRoute(ctx, parts[2], String(parts[3]), call);
	// Everything below changes more than the view key's list (./view-key.ts) allows: the full page's alone. The second lock behind the origin
	// and key gates, so a route added to a list by mistake still does not reach one of these.
	if (authority !== "full")
		return fail(403, "refused: this needs the page's own link, not the key an inline view holds");
	if (parts[1] === "items" && parts[2] && parts[3] === "not-now") return notNowRoute(ctx, parts[2], "page");
	if (url.pathname === "/api/accept-all") {
		const r = await acceptAll(ctx, body.ids);
		return json(r.body, r.status);
	}
	if (parts[1] === "rulings" && parts[2] && parts[3]) return rulingRoute(ctx, parts[2], parts[3], body);
	return fail(404, "not found");
}

export async function api(ctx: Ctx, req: Request, url: URL, authority: Authority): Promise<Response> {
	const parts = pathParts(url.pathname);
	const read = req.method === "GET" ? apiRead(ctx, url, parts) : undefined;
	if (read) return read;
	if (req.method !== "POST") return fail(404, "not found");
	const body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "expected a JSON body");
	return apiPost(ctx, { req, url, parts, body, authority });
}

// ---- the pages ----------------------------------------------------------------------------------------

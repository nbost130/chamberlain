/**
 * The decision-queue web app: the queue, an item's detail and the rulings page, over one JSON API. Everything that
 * touches the network or the clock comes in through deps, so the tests drive the real handler.
 */
import { TOKEN_HEADER, TOKEN_PARAM, type Capability } from "../core/capability.ts";
import { crashPoint } from "../core/crash.ts";
import { readHealth, HEALTH_CONFIG } from "../core/steward-health.ts";
import { closeHeldForItem } from "../core/afk.ts";
import {
	answerDeliveryId,
	batchable,
	claimWake,
	enqueueClaim,
	fallbackWake,
	finishRelay,
	notNow,
	PAGE,
	pageClaim,
	questionStates,
	ranked,
	readRelay,
	recordAnswerDelivered,
	recoverClaims,
	startRelay,
	wokenBy,
	type Answer,
	type Claim,
	type ClaimRelay,
	type QuestionState,
} from "../core/questions.ts";
import {
	CHALLENGE_TTL_MS,
	consumeChallenge,
	issueChallenge,
	newSession,
	SESSION_COOKIE,
	sessionOf,
} from "../core/challenge.ts";
import {
	citations,
	confirmRuling,
	editRuling,
	expiresProblem,
	inForceNow,
	isExpired,
	readRulings,
	recordInForce,
	retireRuling,
	stageRulings,
	type Clock,
} from "../core/rulings.ts";
import type { Store } from "../core/store.ts";
import { resolveEvidence } from "./evidence.ts";
import { checkCard, needsConfirmation, type SendToThread } from "./waiting.ts";

export type AppDeps = {
	/** The database the queue, rulings, claims and wakes live in. */
	store: Store;
	/** The state directory: where the evidence files live (the Store holds the rows that point to them). */
	state: string;
	/** Sends a thread-routed answer straight to its thread (threadSender in ./waiting.ts). Without it, every answer goes to the Steward. */
	sendToThread?: SendToThread;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Host header values accepted, e.g. "<tailscale-ip>:3790". A request for any other host is refused (DNS rebinding). */
	hosts: string[];
	/**
	 * The capability token every request to the API, an item's evidence and the page itself must prove it holds (src/core/capability.ts). There is
	 * no way to leave it out: a page without one would answer anything that reaches its port.
	 */
	capability: Capability;
	threadLinks?: Record<string, string>;
	/** Cards waiting in other threads (src/web/waiting.ts). */
	mirror?: Pick<import("./waiting.ts").Waiting, "list" | "answer"> &
		Partial<Pick<import("./waiting.ts").Waiting, "unreachable">>;
	/** A directory holding index.html, app.css, app.js and inline.js; or `staticFiles`. */
	staticDir?: string;
	/** Each static file's path by the URL path it is served at (src/embedded.ts); wins over `staticDir`. */
	staticFiles?: Record<string, string>;
	testMode?: boolean;
	/** The clock the confirmation challenges and the rulings (what has expired) use. Default Date.now; tests move it. */
	now?: () => number;
};

/**
 * Is this Content-Type the JSON media type? The media type is the part before the first ";" and must be exactly `application/json`
 * (type and subtype are case-insensitive, RFC 9110 section 8.3.1), optionally followed by parameters such as `charset=utf-8`.
 * A prefix match is wrong: `application/jsonxxx` and `application/json-seq` are other types. Part of the cross-site guard on every POST.
 */
export const isJsonContentType = (value: string | null | undefined): boolean =>
	(value ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
const fail = (status: number, error: string) => json({ error }, status);
const SECURITY = {
	"content-security-policy":
		"default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
const withSecurity = (r: Response) => {
	for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
	return r;
};
/**
 * What an inline frame (a request whose origin is exactly "null") may do, and nothing else. Enforced here, on the server, on the
 * route AND on the request's fields: the page's own script is not what is trusted, the request is.
 *   - GET /api/queue, /api/recent, /api/rulings;
 *   - POST /api/items/<id>/answer with `choice` and an optional `note` and no other field.
 * Not a ruling field (saveRuling, rulingWording), not a card or an approval (those are answered on the full page, behind a
 * confirmation challenge), not an item's own read, not a ruling change, not a batch accept.
 */
const INLINE_READS = new Set(["/api/queue", "/api/recent", "/api/rulings"]);
const INLINE_ANSWER = /^\/api\/items\/Q-[a-z0-9]{4,16}\/answer$/;
const INLINE_ANSWER_FIELDS = new Set(["choice", "note"]);
/** Pure: the verdict on a request from an inline frame, by method and path. */
export function inlineVerdict(
	method: string,
	pathname: string,
): "read" | "answer" | "preflight-read" | "preflight-answer" | "refuse" {
	if (method === "GET") return INLINE_READS.has(pathname) ? "read" : "refuse";
	if (method === "POST") return INLINE_ANSWER.test(pathname) ? "answer" : "refuse";
	if (method === "OPTIONS")
		return INLINE_READS.has(pathname) ? "preflight-read" : INLINE_ANSWER.test(pathname) ? "preflight-answer" : "refuse";
	return "refuse";
}
/** CORS for T3's inline frames (origin "null"), on INLINE_API only. */
const inlineCors = (r: Response) => {
	r.headers.set("access-control-allow-origin", "null");
	r.headers.set("access-control-allow-methods", "GET, POST");
	r.headers.set("access-control-allow-headers", `content-type, x-decision-queue, ${TOKEN_HEADER}`);
	r.headers.set("access-control-allow-private-network", "true");
	r.headers.set("access-control-max-age", "600");
	r.headers.set("vary", "origin");
	return r;
};

export function createApp(d: AppDeps) {
	// One change at a time: two answers to the same item must not both see it open.
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
		const p = chain.then(fn, fn);
		chain = p.catch(() => undefined);
		return p;
	};
	const background = new Set<Promise<unknown>>();
	// A rejected background task is logged, never left unhandled: the next heartbeat retries it.
	const track = (p: Promise<unknown>) => {
		const q = p.catch((e) => d.log("background-error", { error: String(e).slice(0, 200) }));
		background.add(q);
		q.finally(() => background.delete(q));
	};

	const state = () => questionStates(d.store);
	const clock: Clock = () => d.now?.() ?? Date.now();
	const rulings = () => readRulings(d.store);
	const decisions = () => d.store.decisions.list();

	const threadLink = (i: QuestionState) =>
		i.threadId && d.threadLinks?.[i.server] ? d.threadLinks[i.server] + encodeURIComponent(i.threadId) : undefined;
	const view = (i: QuestionState) => ({ ...i, link: threadLink(i), batchable: batchable(i) });

	/**
	 * A claim whose wake is not yet an outbox row: a thread-routed answer goes straight to its thread, once, and only if that fails is the
	 * Steward's fallback wake written; any other claim's wake is written as it is. The page never sends a wake: the daemon's relay does.
	 */
	const sending = new Set<string>();
	async function follow(c: Claim) {
		// One direct send at a time per answer: a heartbeat must not start it again while the first is still running.
		if (sending.has(c.deliveryId)) return;
		sending.add(c.deliveryId);
		try {
			const direct = c.relay ? await relayToThread(c, c.relay) : undefined;
			if (direct?.delivered) recordAnswerDelivered(d.store, c.deliveryId);
			else if (enqueueClaim(d.store, c, direct?.message))
				d.log("wake-queued", { id: c.item, deliveryId: c.deliveryId });
		} finally {
			sending.delete(c.deliveryId);
		}
	}

	/**
	 * The one direct send of a thread-routed answer. Its relays row is taken before the send, so the thread is sent to
	 * at most once per item, whatever crashes or repeats follow. Delivered: the Steward gets no wake, only the ledger
	 * row (and its outcome) and a log line. Failed, refused, or cut short by a crash: the Steward gets
	 * the claim's fallback wake, which says the direct send failed and why.
	 */
	async function relayToThread(
		c: Claim,
		r: ClaimRelay,
	): Promise<{ delivered: true } | { delivered: false; message: string }> {
		const fallback = (detail: string) => ({ delivered: false as const, message: fallbackWake(c.message, detail) });
		const record = (outcome: "delivered" | "failed", detail: string) => {
			try {
				finishRelay(d.store, c.item, outcome, detail);
			} catch (e) {
				d.log("relay-record-failed", { item: c.item, error: String(e).slice(0, 200) });
			}
			d.log("relayed-to-thread", {
				item: c.item,
				choice: c.answer?.label,
				server: r.server,
				threadId: r.threadId,
				outcome,
				detail,
			});
			if (outcome === "delivered") closeHoldFor(c);
		};
		const prior = readRelay(d.store, c.item);
		if (prior.outcome === "delivered") return { delivered: true };
		if (prior.outcome === "failed") return fallback(prior.detail ?? "the direct send failed");
		let taken: boolean;
		try {
			taken = !prior.started && startRelay(d.store, c.item);
		} catch (e) {
			// The send can't be taken (a full disk, a refused row), so nothing went to the thread: the Steward relays it.
			const detail = `the direct send could not start: ${String(e).replace(/\s+/g, " ").slice(0, 200)}`;
			d.log("relayed-to-thread", {
				item: c.item,
				choice: c.answer?.label,
				server: r.server,
				threadId: r.threadId,
				outcome: "failed",
				detail,
			});
			return fallback(detail);
		}
		if (!taken) {
			const detail =
				"the direct send was cut short, so it may or may not have reached the thread; it is never sent twice";
			record("failed", detail);
			return fallback(detail);
		}
		const sent = d.sendToThread
			? await d
					.sendToThread(r.server, r.threadId, r.message, `relay\0${c.item}`)
					.catch((e) => ({ ok: false, detail: String(e).slice(0, 200) }))
			: { ok: false, detail: "this page has no way to send to threads (test mode)" };
		record(sent.ok ? "delivered" : "failed", sent.detail);
		return sent.ok ? { delivered: true } : fallback(sent.detail);
	}
	/** A direct delivery sends no answer wake, so nothing tells the Steward to close its hold on the item: close it here. */
	function closeHoldFor(c: Claim) {
		try {
			const n = closeHeldForItem(
				d.store,
				c.item,
				`Answered on the queue page and sent straight to its thread (${c.answer?.label ?? "their choice"}); closed by the queue page.`,
			);
			if (n) d.log("held-closed-for-item", { item: c.item, closed: n });
		} catch (e) {
			d.log("held-close-failed", { item: c.item, error: String(e).slice(0, 200) });
		}
	}
	/** True when this answer's delivery ID went straight to its thread instead of waking the Steward. */
	const relayedDirect = (deliveryId: string) => {
		const id = deliveryId.match(/^answer:item:(Q-[a-z0-9]{4,16})$/)?.[1];
		return Boolean(id && readRelay(d.store, id).outcome === "delivered");
	};

	type AnswerIn = { choice: number; note?: string; saveRuling?: boolean; rulingWording?: string };
	/** Records the principal's answer once. A second answer to the same item is refused, so it can never send a second wake. */
	function answer(
		id: string,
		body: AnswerIn,
		by: "page" | "batch",
		inline = false,
	): Promise<{ status: number; body: unknown }> {
		return serial(() => {
			// An inline frame answers a question with a choice and a note. A ruling field in its request is refused, not ignored, whatever
			// the item or the ticked box would have made of it: only the full page may save a ruling.
			if (inline) {
				const extra = Object.keys(body).filter((k) => !INLINE_ANSWER_FIELDS.has(k));
				if (extra.length)
					return {
						status: 403,
						body: {
							error: `an inline frame may only choose an option and add a note, not ${extra.map((k) => JSON.stringify(k)).join(", ")}: answer on the full page`,
						},
					};
				if (body.note !== undefined && typeof body.note !== "string")
					return { status: 400, body: { error: "note must be text" } };
			}
			const i = state().get(id);
			if (!i) return { status: 404, body: { error: "no such item" } };
			if (i.status !== "open")
				return {
					status: 409,
					body: { error: i.status === "answered" ? "already answered" : "already answered on its question card in T3" },
				};
			if (i.secret)
				return { status: 400, body: { error: "a secret is entered in its own thread, never on this page" } };
			// A card pointer closes only when its card does. An answer here would take it off the queue (and its hold off the ledger) while the
			// card still waits, so it is refused, and the refusal says where to act.
			if (i.cardRequest)
				return {
					status: 409,
					body: {
						error:
							"this question points to a question card waiting in its thread: act on the card itself; this question and its hold close only when the card does",
					},
				};
			if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice >= i.options.length)
				return { status: 400, body: { error: "choose one of the options" } };
			const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 4000) : undefined;
			const label = i.options[body.choice]!.label;
			// Only an explicit tick saves a ruling, and only on a single answer: a batch never carries one.
			const wantsRuling = body.saveRuling === true && by === "page";
			const decides = wantsRuling
				? (typeof body.rulingWording === "string" && body.rulingWording.trim()) || i.proposedRuling
				: undefined;
			if (wantsRuling && !decides) return { status: 400, body: { error: "there is no ruling wording to save" } };
			const expiryProblem = decides && i.proposedExpires ? expiresProblem(i.proposedExpires) : undefined;
			if (expiryProblem)
				return {
					status: 400,
					body: {
						error: `the proposed ruling's expiry ${expiryProblem}: save it without a ruling, or write a new one`,
					},
				};
			if (decides && i.proposedExpires && isExpired({ expires: i.proposedExpires }, clock()))
				return {
					status: 400,
					body: {
						error: `the proposed ruling expired on ${i.proposedExpires}: save it without a ruling, or write a new one`,
					},
				};
			const taken = (owner: string) => ({
				status: 409,
				body: { error: owner === PAGE ? "already answered" : "already answered on its question card in T3" },
			});
			const held = wokenBy(d.store, i.id);
			if (held !== undefined) return taken(held);
			// Every refusal comes before the claim, and a refused answer writes nothing. The claim, the answer, the ruling it saves and
			// the wake's outbox row are ONE transaction: they commit together or not at all, so no crash can leave the answer half made.
			// An item whose one wake is already claimed (by an earlier answer, in this process or another) refuses this one.
			const base: Answer = {
				choice: body.choice,
				label,
				...(note ? { note } : {}),
				by,
				t: new Date().toISOString(),
				deliveryId: answerDeliveryId(i.id),
			};
			const made: { claim?: Claim; lost?: Claim } = {};
			d.store.tx(() => {
				// The ruling is recorded in the list in memory (an identical live ruling is that ruling, so saving twice adds nothing) and saved
				// only once the claim is won, in this same transaction.
				const staged = stageRulings(d.store);
				const ruling = decides
					? recordInForce(
							staged.list,
							`${label}${note ? `. ${note}` : ""}`,
							decides.trim(),
							"card",
							`saved and confirmed by the principal on the queue page, answering ${i.id}`,
							i.id,
							i.proposedExpires ? { expires: i.proposedExpires } : undefined,
							clock(),
						)
					: undefined;
				const c = pageClaim(i, ruling ? { ...base, ruling: { id: ruling.id, decides: ruling.decides } } : base, ruling);
				const r = claimWake(d.store, c);
				if (!r.won) {
					made.lost = r.claim;
					return;
				}
				if (ruling) staged.commit();
				// A thread-routed answer's wake is only its fallback: it is written if the direct send fails (follow).
				if (!c.relay) enqueueClaim(d.store, c);
				made.claim = c;
				crashPoint("before-commit");
			});
			const claim = made.claim;
			if (!claim) return taken(made.lost?.owner ?? "");
			crashPoint("committed");
			const a = claim.answer!;
			d.log("answered", { id: i.id, choice: a.choice, by, ruling: a.ruling?.id });
			if (claim.relay) track(follow(claim));
			// Recorded now; the wake is queued for the daemon's relay, which sends it on its next poll (one second by default) while the daemon runs and is not busy with an earlier row.
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
		});
	}

	async function acceptAll(ids: unknown) {
		if (!Array.isArray(ids)) return { status: 400, body: { error: "ids must be a list" } };
		const answered: string[] = [];
		const skipped: { id: string; why: string }[] = [];
		for (const id of ids.map(String)) {
			const i = state().get(id);
			if (!i) {
				skipped.push({ id, why: "no such item" });
				continue;
			}
			if (i.kind === "only-you") {
				skipped.push({ id, why: "only you can answer this one" });
				continue;
			}
			if (!batchable(i)) {
				skipped.push({
					id,
					why: i.secret ? "a secret" : i.status !== "open" ? "already answered" : "no recommendation",
				});
				continue;
			}
			const r = await answer(id, { choice: i.recommended! }, "batch");
			if (r.status === 200) answered.push(id);
			else skipped.push({ id, why: String((r.body as { error?: string }).error) });
		}
		return { status: 200, body: { answered, skipped } };
	}

	/**
	 * Startup and each heartbeat. Each of the page's claims whose wake is delivered (or went straight to its thread) is marked delivered;
	 * one whose wake the outbox already knows is the relay's; any other (a claim from before the outbox row was part of the answer, or a
	 * thread send cut short) is written to the outbox now, under its one id. Only the database decides, so a fresh process does the same.
	 */
	async function recover() {
		if (!d.testMode) {
			await recoverClaims({
				store: d.store,
				owns: (o) => o === PAGE,
				log: d.log,
				done: (c) => d.store.wakes.isDelivered(c.deliveryId) || relayedDirect(c.deliveryId),
				delivered: (c) => {
					recordAnswerDelivered(d.store, c.deliveryId);
					if (relayedDirect(c.deliveryId)) closeHoldFor(c);
				},
				send: (c) => follow(c),
			});
		}
	}

	function rulingsView() {
		const list = rulings();
		const cites = citations(decisions());
		return list.map((r) => ({
			...r,
			expired: r.status === "in-force" && isExpired(r, clock()),
			cited: cites.get(r.id)?.length ?? 0,
			recent: (cites.get(r.id) ?? []).slice(0, 3),
		}));
	}

	async function api(req: Request, url: URL, inline: boolean): Promise<Response> {
		const parts = url.pathname
			.split("/")
			.filter(Boolean)
			.map((p) => {
				try {
					return decodeURIComponent(p);
				} catch {
					return "\0";
				}
			});
		if (req.method === "GET" && url.pathname === "/api/queue") {
			const s = state();
			const open = ranked(s.values()).map(view);
			const list = rulings();
			return json({
				items: open,
				cards: d.mirror?.list() ?? [],
				unreachable: d.mirror?.unreachable?.() ?? [],
				health: readHealth(d.store) ?? null,
				healthLimits: HEALTH_CONFIG,
				inForce: inForceNow(list, clock()).length,
				unconfirmed: list.filter((r) => r.status !== "retired" && !r.confirmed).length,
				testMode: Boolean(d.testMode),
			});
		}
		if (req.method === "GET" && parts[1] === "items" && parts[2] && parts.length === 3) {
			const i = state().get(parts[2]);
			return i ? json(view(i)) : fail(404, "no such item");
		}
		if (req.method === "GET" && url.pathname === "/api/rulings") return json({ rulings: rulingsView() });
		if (req.method === "GET" && url.pathname === "/api/recent") {
			const done = [...state().values()]
				.filter((i) => i.status !== "open")
				.map((i) => ({ ...view(i), at: i.answer?.t ?? i.createdAt }));
			done.sort((a, b) => String(b.at).localeCompare(String(a.at)));
			return json({ items: done.slice(0, 20) });
		}
		if (req.method !== "POST") return fail(404, "not found");
		const body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
		if (!body || typeof body !== "object") return fail(400, "expected a JSON body");
		if (parts[1] === "cards" && parts[2] && (parts[3] === "answer" || parts[3] === "confirm") && parts.length === 4) {
			// Approvals and cards are answered on the full page only (see inlineVerdict); this is the second lock on the same door.
			if (inline)
				return fail(403, "refused: question cards and approvals are answered on the full page, not in an inline frame");
			if (!d.mirror) return fail(404, "not found");
			const id = parts[2];
			const b = body as { choice?: unknown; sig?: unknown; challenge?: unknown };
			const card = d.mirror.list().find((c) => c.id === id);
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
			if (parts[3] === "confirm") {
				// Step one: only a card that needs confirming gets a challenge, and only for what the operator saw and chose.
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
				d.log("card-confirmation-issued", {
					id,
					type: checked.card.type,
					choice: checked.card.options[checked.choice]?.label,
				});
				return withSession(
					json({
						ok: true,
						challenge: token,
						expiresAt,
						expiresInMs: CHALLENGE_TTL_MS,
						decision: checked.card.options[checked.choice]!.label,
					}),
				);
			}
			// Step two. An approval or goal answer without the server's own confirmation is refused, however it was sent.
			if (card?.answerable && needsConfirmation(card)) {
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
				if (verdict !== "ok") {
					d.log("card-confirmation-refused", { id, type: card.type, verdict });
					const [status, error] =
						verdict === "missing"
							? [428, "this answer needs a confirmation first: ask for one, then confirm"]
							: verdict === "expired"
								? [410, "the confirmation expired: confirm again"]
								: verdict === "used"
									? [403, "that confirmation was already used: confirm again"]
									: [403, "that confirmation is not for this card, this choice or this session: confirm again"];
					return json({ error, code: `confirmation-${verdict}` }, status);
				}
			}
			const r = await serial(() => d.mirror!.answer(id, b.choice, b.sig));
			return json(r.body, r.status);
		}
		if (parts[1] === "items" && parts[2] && parts[3] === "answer") {
			const r = await answer(parts[2], body as unknown as AnswerIn, "page", inline);
			return json(r.body, r.status);
		}
		if (parts[1] === "items" && parts[2] && parts[3] === "not-now") {
			const id = parts[2];
			return serial(() => {
				const i = state().get(id);
				if (!i || i.status !== "open") return fail(404, "no open item");
				notNow(d.store, id);
				return json({ ok: true });
			});
		}
		if (url.pathname === "/api/accept-all") {
			const r = await acceptAll(body.ids);
			return json(r.body, r.status);
		}
		if (parts[1] === "rulings" && parts[2] && parts[3]) {
			const [id, action] = [parts[2], parts[3]];
			const decides = typeof body.decides === "string" ? body.decides : undefined;
			try {
				const r =
					action === "confirm"
						? confirmRuling(d.store, id, decides, clock)
						: action === "edit"
							? editRuling(d.store, id, decides ?? "", clock)
							: action === "once"
								? retireRuling(d.store, id, "only this once", undefined, undefined, clock)
								: action === "retire"
									? retireRuling(d.store, id, "retired", undefined, undefined, clock)
									: undefined;
				if (!r) return fail(404, "unknown action");
				d.log("ruling-changed", { id, action });
				return json({ ok: true, ruling: r });
			} catch (e) {
				return fail(400, String((e as Error).message));
			}
		}
		return fail(404, "not found");
	}

	function evidence(url: URL): Response {
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length !== 3) return fail(404, "not found");
		let itemId: string, name: string;
		try {
			itemId = decodeURIComponent(parts[1]!);
			name = decodeURIComponent(parts[2]!);
		} catch {
			return fail(404, "not found");
		}
		const item = state().get(itemId);
		const listed = (item?.evidence ?? []).filter((e) => e.type !== "link" && e.path).map((e) => e.path!);
		const hit = resolveEvidence(d.state, itemId, name, listed);
		if (!hit) return fail(404, "not found");
		return new Response(Bun.file(hit.path), {
			headers: { "content-type": hit.type, "cache-control": "private, max-age=3600" },
		});
	}

	const staticPath = (name: string) => d.staticFiles?.[name] ?? `${d.staticDir}${name}`;
	const STATIC: Record<string, string> = {
		"/app.js": "text/javascript; charset=utf-8",
		"/app.css": "text/css; charset=utf-8",
		"/inline.js": "text/javascript; charset=utf-8",
	};

	/** The page a browser without the key gets: static, and it says how to get one. */
	const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decisions</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.2rem">This page needs its link</h1><p>Open the link Chamberlain gave you. To get a fresh one, run <code>chamberlain web link</code> on the machine that runs Chamberlain.</p></body></html>`;
	const locked = (inlineReply: boolean) => {
		// Plain text, not JSON: a frame still running the previous build's script reads every reply as JSON, and would show an empty queue for a
		// JSON error object. A text body makes it fail loudly ("could not reach the queue") instead.
		const r = withSecurity(
			new Response("Locked: this request carries no valid key. Run `chamberlain web link` for a fresh link.\n", {
				status: 401,
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			}),
		);
		r.headers.set("www-authenticate", "Bearer");
		return inlineReply ? inlineCors(r) : r;
	};
	const isShell = (p: string) => p === "/" || p === "/rulings" || /^\/item\/Q-[a-z0-9]{4,16}$/.test(p);

	async function fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		// The page binds to one address. A Host it doesn't know is a rebinding attempt or a mistake.
		if (!d.hosts.includes(req.headers.get("host") ?? "")) return withSecurity(fail(421, "unknown host"));
		const origin = req.headers.get("origin");
		const sameOrigin = origin !== null && d.hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`);
		// T3 shows inline pages in a sandboxed frame whose origin is "null". It is let in only with the capability token (below), and then only
		// for what inlineVerdict allows: three reads, and an answer that is a choice and a note. It cannot save a ruling, answer a card or an
		// approval, read one item, or change anything else. A page on any other origin is refused outright, whatever it sends.
		const inline = origin === "null";
		if (origin !== null && !inline && !sameOrigin) return withSecurity(fail(403, "refused: cross-origin request"));
		const verdict = inline ? inlineVerdict(req.method, url.pathname) : undefined;
		// A null-origin request outside the list is refused whatever it is. (Static files carry no Origin when a frame loads them.)
		if (inline && verdict === "refuse" && (url.pathname.startsWith("/api/") || req.method !== "GET"))
			return withSecurity(
				fail(403, "refused: an inline frame may read the queue, recent answers and rulings, and answer a question"),
			);
		const allowed = inline && verdict !== "refuse";
		// A preflight cannot carry the token, so it is answered; it grants nothing, and the request it clears is checked below.
		if (allowed && req.method === "OPTIONS") return withSecurity(inlineCors(new Response(null, { status: 204 })));
		// Static files are the page's own code and carry no data: served to any request that reached the right Host.
		if (req.method === "GET" && STATIC[url.pathname])
			return withSecurity(
				new Response(Bun.file(staticPath(url.pathname)), {
					headers: { "content-type": STATIC[url.pathname]!, "cache-control": "no-cache" },
				}),
			);
		// The capability. Three ways to show it, none of them from a frame that is not ours:
		//   the header (an inline frame, or a tool);
		//   the cookie (a browser that opened a link; never for a null origin, which holds no cookie of ours);
		//   `?k=` on a page or evidence GET (a link: the page load sets the cookie and drops the key from the address).
		const byHeader = d.capability.accepts(req.headers.get(TOKEN_HEADER));
		// A cookie reaches an item's evidence only from the page's own origin (or a direct navigation): another PORT on the same host is "same-site", not
		// "same-origin", and must not be able to embed the evidence images with the owner's cookie. The header and ?k= are explicit and unaffected.
		const fetchSite = req.headers.get("sec-fetch-site");
		const cookieOk = !url.pathname.startsWith("/evidence/") || fetchSite === "same-origin" || fetchSite === "none";
		const byCookie = !inline && cookieOk && d.capability.acceptsCookie(req.headers.get("cookie"));
		const linkable =
			req.method === "GET" && !inline && (isShell(url.pathname) || url.pathname.startsWith("/evidence/"));
		const linkKey = url.searchParams.get(TOKEN_PARAM);
		const byLink = linkable && linkKey !== null && d.capability.accepts(linkKey);
		if (!byHeader && !byCookie && !byLink) {
			// A page load without the key gets the static "needs its link" page, not the app; everything else a plain 401.
			if (req.method === "GET" && isShell(url.pathname))
				return withSecurity(
					new Response(LOCKED_PAGE, {
						status: 401,
						headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
					}),
				);
			return locked(allowed);
		}
		if (byLink && isShell(url.pathname)) {
			// A link: set the long-lived cookie and go to the same page without the key, so it is not left in the address bar or history.
			const clean = new URL(url);
			clean.searchParams.delete(TOKEN_PARAM);
			const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
			return withSecurity(
				new Response(null, {
					status: 303,
					headers: {
						location: `${clean.pathname}${clean.search}`,
						"set-cookie": d.capability.grant(secure),
						"cache-control": "no-store",
					},
				}),
			);
		}
		if (req.method === "POST") {
			// A cross-site form can't set this header or this content type, so a page elsewhere can't answer for the principal.
			if (
				req.headers.get("x-decision-queue") !== "1" ||
				!isJsonContentType(req.headers.get("content-type")) ||
				(origin && !allowed && !sameOrigin)
			)
				return withSecurity(fail(403, "refused"));
		}
		if (url.pathname.startsWith("/api/")) {
			const r = withSecurity(await api(req, url, inline));
			return allowed ? inlineCors(r) : r;
		}
		if (req.method !== "GET") return withSecurity(fail(404, "not found"));
		if (url.pathname.startsWith("/evidence/")) return withSecurity(evidence(url));
		if (isShell(url.pathname))
			return withSecurity(
				new Response(Bun.file(staticPath("/index.html")), {
					headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
				}),
			);
		return withSecurity(fail(404, "not found"));
	}

	/** How many questions wait on the principal: the count the Decisions thread title shows. */
	const openCount = () => ranked(state().values()).length + (d.mirror?.list().length ?? 0);

	return {
		fetch,
		answer,
		acceptAll,
		recover,
		openCount,
		idle: async () => {
			while (background.size) await Promise.all([...background]);
		},
	};
}

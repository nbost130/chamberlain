/**
 * The decision-queue web app: the queue, an item's detail and the rulings page, over one JSON API. Everything that
 * touches the network or the clock comes in through deps, so the tests drive the real handler.
 */

import type { WaitingCard } from "../core/adapter.ts";
import { closeHeldForItem } from "../core/afk.ts";
import { type Capability, TOKEN_HEADER, TOKEN_PARAM } from "../core/capability.ts";
import {
	CHALLENGE_TTL_MS,
	consumeChallenge,
	issueChallenge,
	newSession,
	SESSION_COOKIE,
	sessionOf,
} from "../core/challenge.ts";
import { crashPoint } from "../core/crash.ts";
import { ledgerEvents } from "../core/obs/ledger.ts";
import {
	type Answer,
	answerDeliveryId,
	batchable,
	type Claim,
	type ClaimRelay,
	claimWake,
	enqueueClaim,
	fallbackWake,
	finishRelay,
	notNow,
	PAGE,
	pageClaim,
	type QuestionState,
	questionStates,
	ranked,
	readRelay,
	recordAnswerDelivered,
	recoverClaims,
	snoozed,
	startRelay,
	wokenBy,
} from "../core/questions.ts";
import {
	type Clock,
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
} from "../core/rulings.ts";
import { clearSnooze } from "../core/snooze.ts";
import { HEALTH_CONFIG, readHealth } from "../core/steward-health.ts";
import type { Store } from "../core/store.ts";
import { resolveEvidence } from "./evidence.ts";
import { createItemActions, ITEM_ACTIONS, takenReply, unsettleable } from "./queue-actions.ts";
import { type Linker, openPage } from "./thread-links.ts";
import { checkCard, needsConfirmation, type SendToThread, type Waiting } from "./waiting.ts";

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
	/** Each card's thread link, and where `/open/<server>/<threadId>` sends a device (./thread-links.ts). Without it no card links to its thread. */
	links?: Linker;
	/** Cards waiting in other threads (src/web/waiting.ts). */
	mirror?: Pick<Waiting, "list" | "answer"> & Partial<Pick<Waiting, "unreachable" | "secretRequest">>;
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
	((value ?? "").split(";", 1)[0] ?? "").trim().toLowerCase() === "application/json";
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

/** What every part of one page shares: its deps, the one-change-at-a-time chain, the background tasks and the queue's reads. */
type Ctx = {
	d: AppDeps;
	serial: <T>(fn: () => Promise<T> | T) => Promise<T>;
	track: (p: Promise<unknown>) => void;
	background: Set<Promise<unknown>>;
	/** The delivery IDs whose direct send is running now. */
	sending: Set<string>;
	state: () => ReturnType<typeof questionStates>;
	clock: Clock;
	/** Snooze, un-snooze, direction and dismiss (./queue-actions.ts). */
	items: ReturnType<typeof createItemActions>;
};

function makeCtx(d: AppDeps): Ctx {
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
	const clock: Clock = () => d.now?.() ?? Date.now();
	return {
		d,
		serial,
		track,
		background,
		sending: new Set<string>(),
		// A snooze is read against the clock, so one whose time has passed is back on the active list.
		state: () => questionStates(d.store, clock()),
		clock,
		items: createItemActions({ store: d.store, clock, log: d.log, serial }),
	};
}

const linkOf = (d: AppDeps, server: string, threadId: string | undefined) => {
	if (!threadId || !d.links) return {};
	const link = d.links.link(server, threadId);
	const open = d.links.openPath(server, threadId);
	const app = d.links.appLink(server, threadId);
	return { ...(link ? { link } : {}), ...(open ? { open } : {}), ...(app ? { app } : {}) };
};
/**
 * A secret question's request in its thread, as the mirror's last reads show it (./waiting.ts `secretRequest`): `ended` once no secret
 * box waits there, so the card says the request expired instead of pointing at a box that is gone. Left out when the reads cannot tell.
 * The question stays open either way: the thread still needs the value, and only the thread can open a new box.
 */
const secretOf = (d: AppDeps, i: QuestionState) => {
	if (!i.secret || i.status !== "open") return {};
	const s = d.mirror?.secretRequest?.(i);
	return s ? { secretRequest: s } : {};
};
const view = (d: AppDeps, i: QuestionState) => ({
	...i,
	...linkOf(d, i.server, i.threadId),
	...secretOf(d, i),
	batchable: batchable(i),
});
/** A card read from a thread keeps the link its adapter gave; the page adds the path that opens it from a frame, and the app link. */
const cardView = (d: AppDeps, c: WaitingCard) => {
	const open = d.links?.openPath(c.server, c.threadId);
	const app = d.links?.appLink(c.server, c.threadId);
	return open || app ? { ...c, ...(open ? { open } : {}), ...(app ? { app } : {}) } : c;
};

// ---- a thread-routed answer's direct send -------------------------------------------------------------

type Relayed = { delivered: true } | { delivered: false; message: string };
const fallbackFor = (c: Claim, detail: string): Relayed => ({
	delivered: false,
	message: fallbackWake(c.message, detail),
});

/** A direct delivery sends no answer wake, so nothing tells the Steward to close its hold on the item: close it here. */
function closeHoldFor(ctx: Ctx, c: Claim) {
	const { d } = ctx;
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

function logRelayed(ctx: Ctx, c: Claim, r: ClaimRelay, outcome: "delivered" | "failed", detail: string) {
	ctx.d.log("relayed-to-thread", {
		item: c.item,
		choice: c.answer?.label,
		server: r.server,
		threadId: r.threadId,
		outcome,
		detail,
	});
}

/** The send's outcome, written to its relays row and logged; a delivered one also closes the item's hold. */
function recordRelay(ctx: Ctx, c: Claim, r: ClaimRelay, outcome: "delivered" | "failed", detail: string) {
	try {
		finishRelay(ctx.d.store, c.item, outcome, detail);
	} catch (e) {
		ctx.d.log("relay-record-failed", { item: c.item, error: String(e).slice(0, 200) });
	}
	logRelayed(ctx, c, r, outcome, detail);
	if (outcome === "delivered") closeHoldFor(ctx, c);
}

/** Takes the one send. When the row cannot be written, nothing went to the thread, so the Steward relays it: `failed` says why. */
function tryStartRelay(ctx: Ctx, c: Claim, r: ClaimRelay, started: boolean): { taken: boolean } | { failed: string } {
	try {
		return { taken: !started && startRelay(ctx.d.store, c.item) };
	} catch (e) {
		// The send can't be taken (a full disk, a refused row).
		const detail = `the direct send could not start: ${String(e).replace(/\s+/g, " ").slice(0, 200)}`;
		logRelayed(ctx, c, r, "failed", detail);
		return { failed: detail };
	}
}

async function sendDirect(ctx: Ctx, c: Claim, r: ClaimRelay): Promise<{ ok: boolean; detail: string }> {
	const { sendToThread } = ctx.d;
	if (!sendToThread) return { ok: false, detail: "this page has no way to send to threads (test mode)" };
	return sendToThread(r.server, r.threadId, r.message, `relay\0${c.item}`).catch((e) => ({
		ok: false,
		detail: String(e).slice(0, 200),
	}));
}

/**
 * The one direct send of a thread-routed answer. Its relays row is taken before the send, so the thread is sent to
 * at most once per item, whatever crashes or repeats follow. Delivered: the Steward gets no wake, only the ledger
 * row (and its outcome) and a log line. Failed, refused, or cut short by a crash: the Steward gets
 * the claim's fallback wake, which says the direct send failed and why.
 */
async function relayToThread(ctx: Ctx, c: Claim, r: ClaimRelay): Promise<Relayed> {
	const prior = readRelay(ctx.d.store, c.item);
	if (prior.outcome === "delivered") return { delivered: true };
	if (prior.outcome === "failed") return fallbackFor(c, prior.detail ?? "the direct send failed");
	const start = tryStartRelay(ctx, c, r, prior.started);
	if ("failed" in start) return fallbackFor(c, start.failed);
	if (!start.taken) {
		const detail =
			"the direct send was cut short, so it may or may not have reached the thread; it is never sent twice";
		recordRelay(ctx, c, r, "failed", detail);
		return fallbackFor(c, detail);
	}
	const sent = await sendDirect(ctx, c, r);
	recordRelay(ctx, c, r, sent.ok ? "delivered" : "failed", sent.detail);
	return sent.ok ? { delivered: true } : fallbackFor(c, sent.detail);
}

/**
 * A claim whose wake is not yet an outbox row: a thread-routed answer goes straight to its thread, once, and only if that fails is the
 * Steward's fallback wake written; any other claim's wake is written as it is. The page never sends a wake: the daemon's relay does.
 */
async function follow(ctx: Ctx, c: Claim) {
	const { d, sending } = ctx;
	// One direct send at a time per answer: a heartbeat must not start it again while the first is still running.
	if (sending.has(c.deliveryId)) return;
	sending.add(c.deliveryId);
	try {
		const direct = c.relay ? await relayToThread(ctx, c, c.relay) : undefined;
		if (direct?.delivered) recordAnswerDelivered(d.store, c.deliveryId);
		else if (enqueueClaim(d.store, c, direct?.message)) d.log("wake-queued", { id: c.item, deliveryId: c.deliveryId });
	} finally {
		sending.delete(c.deliveryId);
	}
}

/** True when this answer's delivery ID went straight to its thread instead of waking the Steward. */
const relayedDirect = (ctx: Ctx, deliveryId: string) => {
	const id = deliveryId.match(/^answer:item:(Q-[a-z0-9]{4,16})$/)?.[1];
	return Boolean(id && readRelay(ctx.d.store, id).outcome === "delivered");
};

/**
 * Startup and each heartbeat. Each of the page's claims whose wake is delivered (or went straight to its thread) is marked delivered;
 * one whose wake the outbox already knows is the relay's; any other (a claim from before the outbox row was part of the answer, or a
 * thread send cut short) is written to the outbox now, under its one id. Only the database decides, so a fresh process does the same.
 */
async function recover(ctx: Ctx) {
	const { d } = ctx;
	if (d.testMode) return;
	await recoverClaims({
		store: d.store,
		owns: (o) => o === PAGE,
		log: d.log,
		done: (c) => d.store.wakes.isDelivered(c.deliveryId) || relayedDirect(ctx, c.deliveryId),
		delivered: (c) => {
			recordAnswerDelivered(d.store, c.deliveryId);
			if (relayedDirect(ctx, c.deliveryId)) closeHoldFor(ctx, c);
		},
		send: (c) => follow(ctx, c),
	});
}

// ---- answering ----------------------------------------------------------------------------------------

type AnswerIn = { choice: number; note?: string; saveRuling?: boolean; rulingWording?: string };
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
	decides: string,
	how: string,
) {
	return recordInForce(
		list,
		how,
		decides.trim(),
		"card",
		`saved and confirmed by the principal on the queue page, answering ${i.id}`,
		i.id,
		i.proposedExpires ? { expires: i.proposedExpires } : undefined,
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
		const ruling = decides ? stagedRuling(ctx, i, staged.list, decides, how) : undefined;
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
function recordedReply(ctx: Ctx, i: QuestionState, claim: Claim, by: "page" | "batch", label: string): Reply {
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

function answerNow(ctx: Ctx, id: string, body: AnswerIn, by: "page" | "batch", inline: boolean): Reply {
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
	return recordedReply(ctx, i, made.claim, by, chosen.value);
}

/** Records the principal's answer once. A second answer to the same item is refused, so it can never send a second wake. */
function answer(ctx: Ctx, id: string, body: AnswerIn, by: "page" | "batch", inline = false): Promise<Reply> {
	return ctx.serial(() => answerNow(ctx, id, body, by, inline));
}

/** One item of a batch, answered with its recommendation. Undefined when it was answered, else why it was skipped. */
async function acceptOne(ctx: Ctx, id: string): Promise<string | undefined> {
	const i = ctx.state().get(id);
	if (!i) return "no such item";
	if (i.kind === "only-you") return "only you can answer this one";
	if (!batchable(i) || i.recommended === undefined)
		return i.secret ? "a secret" : i.status !== "open" ? "already answered" : "no recommendation";
	const r = await answer(ctx, id, { choice: i.recommended }, "batch");
	return r.status === 200 ? undefined : String((r.body as { error?: string }).error);
}

async function acceptAll(ctx: Ctx, ids: unknown): Promise<Reply> {
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
	const done = [...ctx.state().values()]
		.filter((i) => i.status !== "open")
		.map((i) => ({ ...view(ctx.d, i), at: i.answer?.t ?? i.dismissal?.t ?? i.createdAt }));
	done.sort((a, b) => String(b.at).localeCompare(String(a.at)));
	return json({ items: done.slice(0, 20) });
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
	id: string,
	card: WaitingCard | undefined,
	b: CardBody,
	session: string,
	withSession: (r: Response) => Response,
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
	d.log("card-confirmation-issued", { id, type: checked.card.type, choice: decision });
	return withSession(json({ ok: true, challenge: token, expiresAt, expiresInMs: CHALLENGE_TTL_MS, decision }));
}

/** Step two. An approval or goal answer without the server's own confirmation is refused, however it was sent. */
function unconfirmedRefusal(
	ctx: Ctx,
	id: string,
	card: WaitingCard,
	b: CardBody,
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
	d.log("card-confirmation-refused", { id, type: card.type, verdict });
	const [status, error] = confirmationRefusal(verdict);
	return json({ error, code: `confirmation-${verdict}` }, status);
}

async function cardsRoute(
	ctx: Ctx,
	req: Request,
	id: string,
	step: "answer" | "confirm",
	body: Record<string, unknown>,
	inline: boolean,
): Promise<Response> {
	const { d } = ctx;
	// Approvals and cards are answered on the full page only (see inlineVerdict); this is the second lock on the same door.
	if (inline)
		return fail(403, "refused: question cards and approvals are answered on the full page, not in an inline frame");
	const { mirror } = d;
	if (!mirror) return fail(404, "not found");
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
	if (step === "confirm") return confirmCard(ctx, id, card, b, session, withSession);
	const refused =
		card?.answerable && needsConfirmation(card) ? unconfirmedRefusal(ctx, id, card, b, session) : undefined;
	if (refused) return refused;
	const r = await ctx.serial(() => mirror.answer(id, b.choice, b.sig));
	return json(r.body, r.status);
}

function notNowRoute(ctx: Ctx, id: string): Promise<Response> {
	return ctx.serial(() => {
		const i = ctx.state().get(id);
		if (i?.status !== "open") return fail(404, "no open item");
		notNow(ctx.d.store, id);
		return json({ ok: true });
	});
}

/**
 * Snooze, un-snooze, direction and dismiss change state, so they are the full page's alone: `inlineVerdict` refuses them to a frame, and this is the
 * second lock on the same door (an `inline` request is a frame's, or one that holds only a view key or no origin).
 */
function itemActionRoute(ctx: Ctx, id: string, action: string, body: Record<string, unknown>, inline: boolean) {
	if (inline)
		return fail(403, "refused: snooze, direction and dismiss are done on the full page, not in an inline frame");
	return ctx.items.run(id, action, body).then((r) => json(r.body, r.status));
}

/** The change a ruling action makes. Undefined for an action that is not one. */
function changeRuling(ctx: Ctx, id: string, action: string, decides: string | undefined) {
	const { store } = ctx.d;
	if (action === "confirm") return confirmRuling(store, id, decides, ctx.clock);
	if (action === "edit") return editRuling(store, id, decides ?? "", ctx.clock);
	if (action === "once") return retireRuling(store, id, "only this once", undefined, undefined, ctx.clock);
	if (action === "retire") return retireRuling(store, id, "retired", undefined, undefined, ctx.clock);
	return undefined;
}

function rulingRoute(ctx: Ctx, id: string, action: string, body: Record<string, unknown>): Response {
	const decides = typeof body.decides === "string" ? body.decides : undefined;
	try {
		const r = changeRuling(ctx, id, action, decides);
		if (!r) return fail(404, "unknown action");
		ctx.d.log("ruling-changed", { id, action });
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
async function apiPost(
	ctx: Ctx,
	req: Request,
	url: URL,
	parts: string[],
	body: Record<string, unknown>,
	inline: boolean,
): Promise<Response> {
	if (parts[1] === "cards" && parts[2] && (parts[3] === "answer" || parts[3] === "confirm") && parts.length === 4)
		return cardsRoute(ctx, req, parts[2], parts[3], body, inline);
	if (parts[1] === "items" && parts[2] && parts[3] === "answer") {
		const r = await answer(ctx, parts[2], body as unknown as AnswerIn, "page", inline);
		return json(r.body, r.status);
	}
	if (parts[1] === "items" && parts[2] && parts.length === 4 && ITEM_ACTIONS.has(String(parts[3])))
		return itemActionRoute(ctx, parts[2], String(parts[3]), body, inline);
	if (parts[1] === "items" && parts[2] && parts[3] === "not-now") return notNowRoute(ctx, parts[2]);
	if (url.pathname === "/api/accept-all") {
		const r = await acceptAll(ctx, body.ids);
		return json(r.body, r.status);
	}
	if (parts[1] === "rulings" && parts[2] && parts[3]) return rulingRoute(ctx, parts[2], parts[3], body);
	return fail(404, "not found");
}

async function api(ctx: Ctx, req: Request, url: URL, inline: boolean): Promise<Response> {
	const parts = pathParts(url.pathname);
	const read = req.method === "GET" ? apiRead(ctx, url, parts) : undefined;
	if (read) return read;
	if (req.method !== "POST") return fail(404, "not found");
	const body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!body || typeof body !== "object") return fail(400, "expected a JSON body");
	return apiPost(ctx, req, url, parts, body, inline);
}

// ---- the pages ----------------------------------------------------------------------------------------

function evidence(ctx: Ctx, url: URL): Response {
	const { d } = ctx;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 3) return fail(404, "not found");
	const [, rawItem = "", rawName = ""] = parts;
	let itemId: string, name: string;
	try {
		itemId = decodeURIComponent(rawItem);
		name = decodeURIComponent(rawName);
	} catch {
		return fail(404, "not found");
	}
	const item = ctx.state().get(itemId);
	const listed = (item?.evidence ?? []).flatMap((e) => (e.type !== "link" && e.path ? [e.path] : []));
	const hit = resolveEvidence(d.state, itemId, name, listed);
	if (!hit) return fail(404, "not found");
	return new Response(Bun.file(hit.path), {
		headers: { "content-type": hit.type, "cache-control": "private, max-age=3600" },
	});
}

const staticPath = (d: AppDeps, name: string) => d.staticFiles?.[name] ?? `${d.staticDir}${name}`;
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
/** `/open/<server>/<threadId>`: sends a device on to the thread's link (./thread-links.ts). A link, like a page: `?k=` signs it in. */
const isOpen = (p: string) => /^\/open\/[^/]+\/[^/]+$/.test(p);
/**
 * Did the person start this navigation with a tap or a click (`Sec-Fetch-User: ?1`, Fetch Metadata; Safari 16.4+, Chrome, Firefox)?
 * Then `/open` answers with a redirect straight to the app: a browser follows a redirect to an app link only inside a navigation the
 * person started (Safari on iOS drops a page's own meta refresh or script navigation to one). Anything else gets the page.
 */
const tapped = (req: Request) => req.headers.get("sec-fetch-user") === "?1";

/** Who a request says it is: whether it comes from an inline frame, and whether that frame may do what it asked. */
type Gate = { inline: boolean; allowed: boolean; origin: string | null; sameOrigin: boolean };

/** Checks Host and Origin: a refusal (or the answer to a preflight) as a Response, or the request's Gate. */
function checkOrigin(d: AppDeps, req: Request, url: URL): Response | Gate {
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
	return { inline, allowed, origin, sameOrigin };
}

/** Static files are the page's own code and carry no data: served to any request that reached the right Host. */
function staticResponse(d: AppDeps, req: Request, url: URL): Response | undefined {
	const type = req.method === "GET" ? STATIC[url.pathname] : undefined;
	if (!type) return undefined;
	return withSecurity(
		new Response(Bun.file(staticPath(d, url.pathname)), {
			headers: { "content-type": type, "cache-control": "no-cache" },
		}),
	);
}

/**
 * The capability. Four ways to show it, none of them from a frame that is not ours:
 *   the cookie (a browser that opened a link; never for a null origin, which holds no cookie of ours);
 *   `?k=` on a page or evidence GET (a link: the page load sets the cookie and drops the key from the address);
 *   the page key in the header, FROM THE PAGE'S OWN ORIGIN;
 *   the header with anything else: the page key from an inline frame or from a request with no Origin at all (curl, an agent), or the
 *   view key (the weak secret a Decisions post carries) from anywhere. Those get inline authority only: inlineVerdict, nothing more.
 * `full` is the first three: everything the page can do. Without it a request is restricted.
 */
function capabilityProof(d: AppDeps, req: Request, url: URL, gate: Gate) {
	const { inline, sameOrigin } = gate;
	const headerKey = req.headers.get(TOKEN_HEADER);
	const byPageKeyHeader = d.capability.accepts(headerKey);
	const byViewKey = !byPageKeyHeader && d.capability.acceptsView(headerKey);
	// A cookie reaches an item's evidence only from the page's own origin (or a direct navigation): another PORT on the same host is "same-site", not
	// "same-origin", and must not be able to embed the evidence images with the owner's cookie. The header and ?k= are explicit and unaffected.
	const fetchSite = req.headers.get("sec-fetch-site");
	const cookieOk = !url.pathname.startsWith("/evidence/") || fetchSite === "same-origin" || fetchSite === "none";
	const byCookie = !inline && cookieOk && d.capability.acceptsCookie(req.headers.get("cookie"));
	const linkable =
		req.method === "GET" &&
		!inline &&
		(isShell(url.pathname) || isOpen(url.pathname) || url.pathname.startsWith("/evidence/"));
	const linkKey = url.searchParams.get(TOKEN_PARAM);
	const byLink = linkable && linkKey !== null && d.capability.accepts(linkKey);
	const full = byCookie || byLink || (byPageKeyHeader && sameOrigin);
	return { byPageKeyHeader, byViewKey, byCookie, byLink, full };
}

/**
 * Inline authority only: a null-origin frame, or a request whose only proof is a header and which has no cookie, no link and no own origin.
 * The same three reads and plain answer; anything else is refused whatever its path, so the key a post carries cannot read an item or its
 * evidence, answer a card or an approval, save a ruling or accept a batch. A refusal here is a 403, not a 401: the key is valid.
 * A null-origin frame's own page-key requests stay exactly as they were (refused for the API; its other GETs pass), except the /open route,
 * which a frame has no use for and which did not exist when that rule was written. The view key is held to the list on every path and from
 * every origin, evidence included.
 * The page's own static shell (`/`, `/rulings`, `/item/<id>`) carries no data and is served to the page key in a header, as it always was: a
 * browser loads it by navigation (cookie, or `?k=`), and a tool may fetch it. What the limit protects is the API, evidence and every write.
 * /open (a tap on a thread link) is the same kind of GET: a redirect to the thread's app link, which /api/queue already hands to an inline
 * frame (a card's `app`), so it adds nothing. A null-origin frame has no use for it, so only a request that is not one may.
 */
function restrictedRefusal(
	req: Request,
	url: URL,
	proof: ReturnType<typeof capabilityProof>,
	inline: boolean,
): Response | undefined {
	const restricted = inline || !proof.full;
	const shellRead =
		req.method === "GET" && proof.byPageKeyHeader && (isShell(url.pathname) || (isOpen(url.pathname) && !inline));
	if (!restricted || shellRead || !(!inline || proof.byViewKey || isOpen(url.pathname))) return undefined;
	const v = inlineVerdict(req.method, url.pathname);
	if (v === "read" || v === "answer") return undefined;
	return withSecurity(
		fail(
			403,
			"refused: this key may read the queue, recent answers and rulings, and answer a question; the rest needs the page's own link",
		),
	);
}

/** A request with no valid key: a page load gets the static "needs its link" page, everything else a plain 401. */
function unauthorized(req: Request, url: URL, allowed: boolean): Response {
	if (req.method === "GET" && isShell(url.pathname))
		return withSecurity(
			new Response(LOCKED_PAGE, {
				status: 401,
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			}),
		);
	return locked(allowed);
}

/** A link: set the long-lived cookie and go to the same page without the key, so it is not left in the address bar or history. */
function linkRedirect(d: AppDeps, req: Request, url: URL): Response {
	const clean = new URL(url);
	clean.searchParams.delete(TOKEN_PARAM);
	const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
	// A tapped `/open` link goes straight on to the thread's target instead (made from the path, never carrying the key).
	const onward = isOpen(url.pathname) && tapped(req) ? openTarget(d, url.pathname) : undefined;
	return withSecurity(
		new Response(null, {
			status: 303,
			headers: {
				location: typeof onward === "string" ? onward : `${clean.pathname}${clean.search}`,
				"set-cookie": d.capability.grant(secure),
				"cache-control": "no-store",
			},
		}),
	);
}

/** A cross-site form can't set this header or this content type, so a page elsewhere can't answer for the principal. */
const postAllowed = (req: Request, g: Gate) =>
	req.headers.get("x-decision-queue") === "1" &&
	isJsonContentType(req.headers.get("content-type")) &&
	!(g.origin && !g.allowed && !g.sameOrigin);

/**
 * Where `/open/<server>/<threadId>` goes: made from the server name and thread id in the path, never taken from the request.
 * A string is the target; a Response is the refusal (a bad address, or no link for that thread).
 */
function openTarget(d: AppDeps, pathname: string): string | Response {
	const [, , rawServer, rawThread] = pathname.split("/");
	let server = "";
	let threadId = "";
	try {
		server = decodeURIComponent(rawServer ?? "");
		threadId = decodeURIComponent(rawThread ?? "");
	} catch {
		return fail(400, "bad thread address");
	}
	return d.links?.target(server, threadId) ?? fail(404, "no link for this thread");
}

/**
 * The `/open` route. A tap gets a 303 straight to the target, so the browser hands it to the app in the same navigation (no page, no
 * second tap). Anything else gets the page that goes on by itself and keeps a button to tap (./thread-links.ts `openPage`).
 */
function openThread(ctx: Ctx, pathname: string, tap: boolean): Response {
	const { d } = ctx;
	const target = openTarget(d, pathname);
	if (typeof target !== "string") return target;
	if (tap) return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
	const [, , rawServer, rawThread] = pathname.split("/");
	const server = decodeURIComponent(rawServer ?? "");
	const threadId = decodeURIComponent(rawThread ?? "");
	const title = d.mirror?.list().find((c) => c.server === server && c.threadId === threadId)?.threadTitle;
	return new Response(openPage(target, title ? `“${title}”` : "the thread"), {
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

/** The pages and files behind the key: evidence, the open page, the app shell. */
function servePage(ctx: Ctx, req: Request, url: URL): Response {
	if (req.method !== "GET") return withSecurity(fail(404, "not found"));
	if (url.pathname.startsWith("/evidence/")) return withSecurity(evidence(ctx, url));
	if (isOpen(url.pathname)) return withSecurity(openThread(ctx, url.pathname, tapped(req)));
	if (isShell(url.pathname))
		return withSecurity(
			new Response(Bun.file(staticPath(ctx.d, "/index.html")), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
			}),
		);
	return withSecurity(fail(404, "not found"));
}

async function handle(ctx: Ctx, req: Request): Promise<Response> {
	const { d } = ctx;
	const url = new URL(req.url);
	const gate = checkOrigin(d, req, url);
	if (gate instanceof Response) return gate;
	const served = staticResponse(d, req, url);
	if (served) return served;
	const proof = capabilityProof(d, req, url, gate);
	if (!proof.full && !proof.byPageKeyHeader && !proof.byViewKey) return unauthorized(req, url, gate.allowed);
	const refused = restrictedRefusal(req, url, proof, gate.inline);
	if (refused) return refused;
	if (proof.byLink && (isShell(url.pathname) || isOpen(url.pathname))) return linkRedirect(d, req, url);
	if (req.method === "POST" && !postAllowed(req, gate)) return withSecurity(fail(403, "refused"));
	if (url.pathname.startsWith("/api/")) {
		const r = withSecurity(await api(ctx, req, url, gate.inline || !proof.full));
		return gate.allowed ? inlineCors(r) : r;
	}
	return servePage(ctx, req, url);
}

export function createApp(d: AppDeps) {
	const ctx = makeCtx(d);
	return {
		fetch: (req: Request) => handle(ctx, req),
		answer: (id: string, body: AnswerIn, by: "page" | "batch", inline = false) => answer(ctx, id, body, by, inline),
		acceptAll: (ids: unknown) => acceptAll(ctx, ids),
		recover: () => recover(ctx),
		/** How many questions wait on the principal: the count the Decisions thread title shows. */
		openCount: () => ranked(ctx.state().values()).length + (d.mirror?.list().length ?? 0),
		idle: async () => {
			while (ctx.background.size) await Promise.all([...ctx.background]);
		},
	};
}

/** A thread-routed answer's direct send: the one relay, its record and its fallback wake. */
import { closeHeldForItem } from "../core/afk-held.ts";
import {
	type Claim,
	type ClaimRelay,
	enqueueClaim,
	finishRelay,
	PAGE,
	readRelay,
	recoverClaims,
	startRelay,
} from "../core/questions-claim.ts";
import { fallbackWake, recordAnswerDelivered } from "../core/questions-wake.ts";
import type { Ctx } from "./app-ctx.ts";

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

/** How a direct send to a thread ended: delivered or failed, and what was seen. */
type RelayResult = { outcome: "delivered" | "failed"; detail: string };

function logRelayed(ctx: Ctx, c: Claim, r: ClaimRelay, { outcome, detail }: RelayResult) {
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
function recordRelay(ctx: Ctx, c: Claim, r: ClaimRelay, res: RelayResult) {
	const { outcome, detail } = res;
	try {
		finishRelay(ctx.d.store, c.item, outcome, detail);
	} catch (e) {
		ctx.d.log("relay-record-failed", { item: c.item, error: String(e).slice(0, 200) });
	}
	logRelayed(ctx, c, r, res);
	if (outcome === "delivered") closeHoldFor(ctx, c);
}

/** Takes the one send. When the row cannot be written, nothing went to the thread, so the Steward relays it: `failed` says why. */
function tryStartRelay(ctx: Ctx, c: Claim, r: ClaimRelay, started: boolean): { taken: boolean } | { failed: string } {
	try {
		return { taken: !started && startRelay(ctx.d.store, c.item) };
	} catch (e) {
		// The send can't be taken (a full disk, a refused row).
		const detail = `the direct send could not start: ${String(e).replace(/\s+/g, " ").slice(0, 200)}`;
		logRelayed(ctx, c, r, { outcome: "failed", detail });
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
		recordRelay(ctx, c, r, { outcome: "failed", detail });
		return fallbackFor(c, detail);
	}
	const sent = await sendDirect(ctx, c, r);
	recordRelay(ctx, c, r, { outcome: sent.ok ? "delivered" : "failed", detail: sent.detail });
	return sent.ok ? { delivered: true } : fallbackFor(c, sent.detail);
}

/**
 * A claim whose wake is not yet an outbox row: a thread-routed answer goes straight to its thread, once, and only if that fails is the
 * Steward's fallback wake written; any other claim's wake is written as it is. The page never sends a wake: the daemon's relay does.
 */
export async function follow(ctx: Ctx, c: Claim) {
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
export async function recover(ctx: Ctx) {
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

/** The Steward health ticker: the hand-off wake it sends and the tick that measures and publishes the health. */

import { formatHealth, HEALTH_CONFIG, HEALTH_KEY, type Health, readHealth } from "./steward-health.ts";
import type { Store } from "./store.ts";

type HealthTickerDeps = {
	store: Store;
	collect: () => Promise<Health>;
	now?: () => number;
	/** Queues the hand-off wake for this session, under `handoffDeliveryId(session)`. Absent (the adapter cannot say how a Steward hands off): the operator is asked instead. */
	handoff?: (h: Health, session: string) => void;
	ask?: (raw: object) => Promise<void>;
	/** The server name shown on the hand-off question: the one the Steward runs on. */
	server?: () => string;
};

/** The collected health, or a WATCH that says the transcript could not be read: a failure is never read as OK. */
async function collectOrUnavailable(collect: () => Promise<Health>, now: number): Promise<Health> {
	try {
		return await collect();
	} catch {
		const h: Health = {
			at: new Date(now).toISOString(),
			verdict: "WATCH",
			replies: 0,
			breaks: 0,
			selfReads: 0,
			threadRereads: 0,
			elevated: [],
			unknown: ["Steward transcript unavailable"],
			report: "",
		};
		h.report = formatHealth(h);
		return h;
	}
}

/** A HAND OFF for one session: the adapter's own hand-off wake, or else one question to the operator (once per session, by its queue tag). */
async function startHandoff(deps: HealthTickerDeps, h: Health, session: string): Promise<void> {
	if (deps.handoff) {
		deps.handoff(h, session);
		return;
	}
	if (!deps.ask) return;
	const tag = `steward-health:${session}`;
	if (deps.store.items.list({ source: "queue" }).some((i) => i.payload.tag === tag)) return;
	await deps.ask({
		kind: "only-you",
		title: "Steward quality has slipped and needs a handoff",
		context:
			h.report +
			"\nQuality signals (format slips or repeat reads) are past their limits, which compaction does not fix. Recommend /steward-handoff; nothing starts automatically.",
		options: [{ label: "Hand off now" }, { label: "Not yet" }],
		recommended: 0,
		thread: "Steward",
		server: deps.server?.() ?? "main",
		threadId: h.thread,
		tag,
	});
}

/**
 * One daemon owns this tick. A HAND OFF verdict starts the hand-off itself when the adapter can say how (`handoff`: it queues the hand-off
 * wake in the outbox, so the relay's attempts, pauses and dead-letter rules apply and nothing is sent from here). Without that, or without
 * a session to name, it asks the operator through the decision queue (`ask`), as before; its queue tag survives a crash between ask.ts and
 * our result write. Either way a session is handled once: the outbox row (or the queue item) is the record, so a restart or a compaction
 * never repeats it.
 */
export function healthTicker(deps: HealthTickerDeps) {
	let busy = false;
	return async () => {
		const now = (deps.now ?? Date.now)(),
			prior = readHealth(deps.store);
		if (busy || (prior && now - Date.parse(prior.at) < HEALTH_CONFIG.intervalMs)) return;
		busy = true;
		try {
			const h = await collectOrUnavailable(deps.collect, now);
			deps.store.state.set(HEALTH_KEY, h);
			if (h.verdict !== "HAND OFF" || !h.session) return;
			await startHandoff(deps, h, h.session);
		} finally {
			busy = false;
		}
	};
}

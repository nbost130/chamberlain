/** The Steward health ticker: the hand-off wake it sends and the tick that measures and publishes the health. */

import type { Store } from "../store/store.ts";
import { formatHealth, HEALTH_KEY, type Health, readHealth } from "./steward-health.ts";
import { HEALTH_CONFIG } from "./steward-health-config.ts";

type HealthTickerDeps = {
	store: Store;
	collect: () => Promise<Health>;
	now?: () => number;
	/** Queues the hand-off wake for this session, under `handoffDeliveryId(session)`. Absent (the adapter cannot say how a Steward hands off): the operator is asked instead. */
	handoff?: (h: Health, session: string) => void;
	ask?: (raw: object) => Promise<void>;
	/** The server name shown on the hand-off question: the one the Steward runs on. */
	server?: () => string;
	/** True when the last compaction of this Steward did not bring its context under the line: compaction cannot help, so the verdict is HAND OFF. */
	compactFailed?: (h: Health) => boolean;
	/** A context fallback can ask for a hand-off without waiting for the next hourly quality check. */
	contextHandoff?: () => { thread: string; session: string; reason: string } | undefined;
};

/** A compaction that left the context above the line is a quality signal compaction cannot fix: the same verdict as any other, with its own line in the report. */
function escalateFailedCompaction(h: Health): Health {
	const next: Health = { ...h, verdict: "HAND OFF", elevated: [...new Set([...h.elevated, "compaction"])] };
	next.report = `${formatHealth(next)}\nThe last compaction did not bring the context under the compaction line; compacting again would repeat it, so this Steward needs a hand-off.`;
	return next;
}

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
			(h.handoffReason
				? "\nRecommend the Steward hand-off procedure."
				: "\nQuality signals (format slips or repeat reads) are past their limits, which compaction does not fix. Recommend /steward-handoff; nothing starts automatically."),
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
		const fallback = deps.contextHandoff?.();
		const urgent = fallback && (fallback.session !== prior?.contextSession || fallback.reason !== prior?.handoffReason);
		if (busy || (!urgent && prior && now - Date.parse(prior.at) < HEALTH_CONFIG.intervalMs)) return;
		busy = true;
		try {
			const collected = await collectOrUnavailable(deps.collect, now);
			const h = applyHandoff(deps, collected, fallback);
			deps.store.state.set(HEALTH_KEY, h);
			if (h.verdict !== "HAND OFF" || !h.session) return;
			await startHandoff(deps, h, h.session);
		} finally {
			busy = false;
		}
	};
}

function applyHandoff(
	deps: HealthTickerDeps,
	h: Health,
	fallback: ReturnType<NonNullable<HealthTickerDeps["contextHandoff"]>>,
): Health {
	if (fallback && fallback.session === h.contextSession && fallback.thread === h.thread) {
		const next: Health = {
			...h,
			session: h.session ?? fallback.session,
			verdict: "HAND OFF",
			handoffReason: fallback.reason,
		};
		next.report = `${formatHealth(next)}\n${fallback.reason}`;
		return next;
	}
	return deps.compactFailed?.(h) ? escalateFailedCompaction(h) : h;
}

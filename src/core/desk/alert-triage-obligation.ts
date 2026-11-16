/** Obligation and sequence items under source alert-triage. */
import type { AlertData } from "../items/alert-data.ts";
import { prepareEvent } from "../items/alert-data-redact.ts";
import type { Store } from "../store/store.ts";
import type { DeskEvent } from "./alert-desk-config.ts";
import { ALERT_TRIAGE, type Right, TRIAGE_KIND_OB, TRIAGE_KIND_SEQ } from "./alert-triage-config.ts";
import { alertKey, attemptId, obKey, occRef, seqKey } from "./alert-triage-ids.ts";
import type { RouteHit } from "./alert-triage-route.ts";

type ObState = "queued" | "sent" | "acked";

export type Obligation = {
	seq: number;
	occ: string;
	state: ObState;
	ordinal: number;
	attempts: string[];
	reason: string;
	rule: string;
	right?: Right;
	event: AlertData;
	firstSeen: string;
	lastSeen: string;
	folded: number;
	readyAt: number;
	missed: number;
	ackedAt?: number;
	repeated?: boolean;
	slot: boolean;
};

export function asOb(p: Record<string, unknown>): Obligation {
	return p as unknown as Obligation;
}

export function listObligations(store: Store, all = false): Obligation[] {
	return store.items
		.list({ source: ALERT_TRIAGE, kind: TRIAGE_KIND_OB, ...(all ? {} : { status: "triggered" as const }) })
		.filter((i) => all || i.status === "triggered")
		.map((i) => asOb(i.payload));
}

export function findByOcc(store: Store, occ: string, all = false): { key: string; ob: Obligation } | undefined {
	for (const i of store.items.list({
		source: ALERT_TRIAGE,
		kind: TRIAGE_KIND_OB,
		...(all ? {} : { status: "triggered" }),
	})) {
		const ob = asOb(i.payload);
		if (ob.occ === occ) return { key: i.dedupKey, ob };
	}
	return undefined;
}

export function slotCount(store: Store): number {
	return listObligations(store).filter((o) => o.slot).length;
}

type OpenArgs = { store: Store; e: DeskEvent; hit: RouteHit; now: number; reason?: string };

function bumpSeq(store: Store, sk: string, now: number): number {
	const seqItem = store.items.get(ALERT_TRIAGE, sk);
	const seq = Number(seqItem?.payload.seq ?? 0) + 1;
	if (seqItem) store.items.patch(ALERT_TRIAGE, sk, { seq });
	else
		store.items.observe({
			source: ALERT_TRIAGE,
			kind: TRIAGE_KIND_SEQ,
			dedupKey: sk,
			mode: "silenced",
			payload: { seq },
			now,
		});
	return seq;
}

function freshPayload(a: OpenArgs, ak: string, seq: number): Obligation {
	const occ = occRef(ak, seq);
	const event = prepareEvent(a.e, { firstSeen: a.e.ts, lastSeen: a.e.ts, folded: 0 });
	return {
		seq,
		occ,
		state: "queued",
		ordinal: 0,
		attempts: [],
		reason: a.reason ?? a.hit.id,
		rule: a.hit.id,
		...(a.hit.right ? { right: a.hit.right } : {}),
		event,
		firstSeen: event.firstSeen,
		lastSeen: event.lastSeen,
		folded: 0,
		readyAt: a.now,
		missed: 0,
		slot: false,
	};
}

/** Open or fold an obligation for a critical event. Returns the occ ref. */
export function upsertObligation(a: OpenArgs): string {
	const ak = alertKey(a.e.source, a.e.family);
	const sk = seqKey(ak);
	const ok = obKey(ak);
	return a.store.tx(() => {
		const existing = a.store.items.get(ALERT_TRIAGE, ok);
		if (existing?.status === "triggered") {
			const ob = asOb(existing.payload);
			const event = prepareEvent(a.e, {
				firstSeen: ob.firstSeen,
				lastSeen: a.e.ts,
				folded: ob.folded + 1,
			});
			a.store.items.patch(ALERT_TRIAGE, ok, { lastSeen: event.lastSeen, folded: ob.folded + 1, event });
			return ob.occ;
		}
		const payload = freshPayload(a, ak, bumpSeq(a.store, sk, a.now));
		a.store.items.observe({
			source: ALERT_TRIAGE,
			kind: TRIAGE_KIND_OB,
			dedupKey: ok,
			mode: "silenced",
			payload,
			now: a.now,
		});
		if (existing?.status === "resolved")
			a.store.items.patch(ALERT_TRIAGE, ok, payload as unknown as Record<string, unknown>);
		return payload.occ;
	});
}

export function redispatch(a: { store: Store; ok: string; reason: string; readyAt: number; slot: boolean }): void {
	const item = a.store.items.get(ALERT_TRIAGE, a.ok);
	if (item?.status !== "triggered") return;
	const ob = asOb(item.payload);
	a.store.items.patch(ALERT_TRIAGE, a.ok, {
		state: "queued",
		ordinal: ob.ordinal + 1,
		reason: a.reason,
		readyAt: a.readyAt,
		slot: a.slot,
		...(a.reason === "repeat" ? { repeated: true } : {}),
	});
}

export function markSent(store: Store, ok: string, id: string, slot: boolean): void {
	const item = store.items.get(ALERT_TRIAGE, ok);
	if (!item) return;
	const ob = asOb(item.payload);
	store.items.patch(ALERT_TRIAGE, ok, { state: "sent", attempts: [...ob.attempts, id], slot });
}

export { attemptId, obKey, seqKey };

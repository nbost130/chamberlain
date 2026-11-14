/**
 * Ledger to events, without a shared transaction (docs/OBSERVABILITY.md section 2). The ledger (`chamberlain.db`) is the truth; every event derived from it has a
 * stable `source_key`, unique in `events`:
 *
 *   decision:<id>          `decision.logged`     a row of `decisions`
 *   item:<id>:asked        `question.asked`      a queue question
 *   item:<id>:answered     `question.answered`   its answer (a page or batch claim, or the card it was answered on)
 *   hold:<handle>:closed   `hold.closed`         a held item that was closed
 *
 * The code that writes a ledger row emits its event inline (`INSERT OR IGNORE`); the reconciler, at start and hourly, opens `chamberlain.db` read-only and emits
 * every row whose key is missing. A crash between the two loses nothing and a retry duplicates nothing. The one-off backfill is the same reconciler.
 *
 * The events are typed: counts, flags, a choice index and durations. A question's title, an answer's note and a decision's words stay in the ledger.
 * Rows the reconciler emits have `corr = NULL` (a repair or a historical row is never guessed to belong to a wake); inline events carry `corr` = the digest of `item:<id>`.
 */

import { obsFor } from "../log.ts";
import type { Item, Store } from "../store.ts";
import { type LedgerDb, openLedger } from "./db.ts";
import { corrOf, isUuid } from "./fields.ts";
import type { Obs, Outcome } from "./obs.ts";

/** An event ready to append: what it is, when, the fields the registry types, the key that makes it appear once, and the thread it is about. */
export type Derived = {
	event: string;
	t: string;
	fields: Record<string, unknown>;
	sourceKey: string;
	thread?: string;
	corr?: string;
};
type Row = Record<string, unknown>;

const iso = (ms: unknown): string => new Date(typeof ms === "number" ? ms : 0).toISOString();
const obj = (v: unknown): Row => {
	if (v && typeof v === "object") return v as Row;
	if (typeof v !== "string") return {};
	try {
		const p = JSON.parse(v) as unknown;
		return p && typeof p === "object" ? (p as Row) : {};
	} catch {
		return {};
	}
};
/** The length of a JSON array held as text (a decision's `ruling_ids`), or 0. */
const listLength = (v: unknown): number => {
	try {
		const p = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
		return Array.isArray(p) ? p.length : 0;
	} catch {
		return 0;
	}
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const decisionKey = (id: number) => `decision:${id}`;
const askedKey = (item: string) => `item:${item}:asked`;
const answeredKey = (item: string) => `item:${item}:answered`;
const holdClosedKey = (handle: string) => `hold:${handle}:closed`;

/** `decision.logged` from a row of `decisions`. */
function decisionEvent(r: Row): Derived {
	return {
		event: "decision.logged",
		t: text(r.t) ?? iso(0),
		fields: { cited: listLength(r.ruling_ids) },
		sourceKey: decisionKey(r.id as number),
		thread: text(r.thread),
	};
}

/** `question.asked` from a queue item (its payload is the question). */
function askedEvent(item: Row): Derived {
	const q = obj(item.payload);
	const id = item.dedup_key as string;
	const options = Array.isArray(q.options) ? q.options.length : 0;
	const fields = {
		item: id,
		options,
		recommended: num(q.recommended),
		urgent: q.urgent !== false,
		own_thread: q.secret === true,
		card: typeof q.cardRequest === "string" && q.cardRequest !== "",
	};
	return {
		event: "question.asked",
		t: iso(item.first_seen),
		fields,
		sourceKey: askedKey(id),
		thread: text(q.threadId),
	};
}

/** `question.answered` from a queue item and its claim's answer, or the card it was answered on; undefined when it was answered neither way. */
function answeredEvent(item: Row): Derived | undefined {
	const q = obj(item.payload);
	const a = obj(item.answer);
	const id = item.dedup_key as string;
	const onCard = q.answeredOnCard === true;
	if (!("choice" in a) && !onCard) return undefined;
	const t = text(a.t) ?? iso(item.resolved_at);
	const choice = num(a.choice);
	const fields = {
		item: id,
		choice,
		recommended: choice !== undefined && choice === num(q.recommended),
		by: onCard ? "card" : text(a.by),
		wait_ms: Math.max(0, Date.parse(t) - (item.first_seen as number)),
		ruled: a.ruling !== undefined && a.ruling !== null,
	};
	return { event: "question.answered", t, fields, sourceKey: answeredKey(id), thread: text(q.threadId) };
}

/** `hold.closed` from a held item that is resolved. */
function holdClosedEvent(item: Row): Derived {
	const p = obj(item.payload);
	const handle = item.dedup_key as string;
	const open = (num(item.resolved_at) ?? 0) - (item.first_seen as number);
	const card = p.card !== undefined || (typeof p.requestId === "string" && p.requestId !== "");
	return {
		event: "hold.closed",
		t: iso(item.resolved_at),
		fields: { open_ms: Math.max(0, open), card },
		sourceKey: holdClosedKey(handle),
		thread: text(p.threadId),
	};
}

/** Appends one derived event: `INSERT OR IGNORE` on its key, so a second emission, inline or reconciled, changes nothing. Never throws. */
function emit(obs: Obs, d: Derived, corr?: string): Outcome {
	// A thread that is not a UUID (a decision's `thread` is whatever the Steward typed) is left out, not counted as a rejection.
	const thread = d.thread !== undefined && isUuid(d.thread) ? d.thread : undefined;
	return obs.record(
		"info",
		d.event,
		d.fields,
		{ mod: "ledger", thread, ...(corr ? { corr } : {}) },
		{ t: d.t, sourceKey: d.sourceKey },
	);
}

/** The queue item the store holds, as the row shape the builders read (the reconciler reads the same shape from SQL). */
const itemRow = (i: Item, answer?: unknown): Row => ({
	dedup_key: i.dedupKey,
	first_seen: i.firstSeen,
	resolved_at: i.resolvedAt,
	payload: i.payload,
	answer,
});

/**
 * The inline emissions: the code that has just committed a ledger row calls one of these, outside its transaction. Each is `INSERT OR IGNORE` on the row's key
 * and never throws, so a telemetry failure can never fail a ledger write (the reconciler repairs what this misses). `corr` joins a question with its answer wake.
 */
export const ledgerEvents = (store: Store) => {
	const safe = (fn: (obs: Obs) => unknown) =>
		store.afterCommit(() => {
			try {
				fn(obsFor(store));
			} catch {
				/* the reconciler emits it */
			}
		});
	return {
		decision: (id: number, d: { t: string; thread: string; rulingIds?: string[] }) =>
			safe((obs) =>
				emit(
					obs,
					decisionEvent({ id, t: d.t, thread: d.thread, ruling_ids: d.rulingIds ? JSON.stringify(d.rulingIds) : null }),
				),
			),
		asked: (id: string) =>
			safe((obs) => {
				const i = store.items.get("queue", id);
				if (i) emit(obs, askedEvent(itemRow(i)), corrOf(`item:${id}`));
			}),
		answered: (id: string, answer?: unknown) =>
			safe((obs) => {
				const i = store.items.get("queue", id);
				const d = i ? answeredEvent(itemRow(i, answer)) : undefined;
				if (d) emit(obs, d, corrOf(`item:${id}`));
			}),
		holdClosed: (handle: string) =>
			safe((obs) => {
				const i = store.items.get("held", handle);
				if (i?.status === "resolved") emit(obs, holdClosedEvent(itemRow(i)));
			}),
	};
};

// ---- the reconciler ----------------------------------------------------------------------------------------

const SQL = {
	decisions: "SELECT id, t, thread, ruling_ids FROM decisions ORDER BY id",
	questions:
		"SELECT i.dedup_key, i.first_seen, i.resolved_at, i.payload, c.answer FROM items i LEFT JOIN claims c ON c.item_id = i.id WHERE i.source = 'queue' AND i.kind = 'question' ORDER BY i.id",
	holds:
		"SELECT dedup_key, first_seen, resolved_at, payload FROM items WHERE source = 'held' AND state = 'resolved' ORDER BY id",
};

export type ReconcileResult = { scanned: number; emitted: number; skipped: number };
export type ReconcileOptions = {
	/** A row this recent is left to the code that wrote it: its inline emission is probably in flight. Default 60 s. */
	graceMs?: number;
	now?: () => number;
};

function present(obs: Obs): Set<string> {
	const rows = (obs.handle?.query("SELECT source_key FROM events WHERE source_key IS NOT NULL").all() ?? []) as {
		source_key: string;
	}[];
	return new Set(rows.map((r) => r.source_key));
}

/** The events the ledger's rows imply, in ledger order. */
function* derive(ledger: LedgerDb): Generator<Derived> {
	for (const r of ledger.query(SQL.decisions).all() as Row[]) yield decisionEvent(r);
	for (const r of ledger.query(SQL.questions).all() as Row[]) {
		yield askedEvent(r);
		const answered = answeredEvent(r);
		if (answered) yield answered;
	}
	for (const r of ledger.query(SQL.holds).all() as Row[]) yield holdClosedEvent(r);
}

/**
 * Emits every event the ledger implies and `obs.db` lacks. Run at start and hourly; the first run on an install is the backfill. A row younger
 * than `graceMs` is skipped, so the inline emission of a write in flight wins (and carries its `corr`). Never throws.
 */
export function reconcile(obs: Obs, ledger: LedgerDb, o: ReconcileOptions = {}): ReconcileResult {
	const out: ReconcileResult = { scanned: 0, emitted: 0, skipped: 0 };
	try {
		const have = present(obs);
		const cutoff = (o.now ?? Date.now)() - (o.graceMs ?? 60_000);
		for (const d of derive(ledger)) {
			out.scanned++;
			if (have.has(d.sourceKey)) continue;
			if (Date.parse(d.t) > cutoff) out.skipped++;
			else if (emit(obs, d) === "stored") out.emitted++;
		}
	} catch {
		/* the next pass picks up whatever this one did not reach */
	}
	return out;
}

const HOUR_MS = 3_600_000;

/** One pass against the ledger at `store.path`, on a read-only handle opened for it. Nothing to do for an in-memory store. Never throws. */
export function reconcileStore(store: Store, o: ReconcileOptions = {}): ReconcileResult | undefined {
	if (store.path === ":memory:") return undefined;
	let ledger: LedgerDb | undefined;
	try {
		ledger = openLedger(store.path);
		const obs = obsFor(store);
		const r = reconcile(obs, ledger, o);
		obs.checkpoint();
		if (r.emitted > 0) obs.record("info", "obs.reconciled", { ...r }, { mod: "ledger" });
		return r;
	} catch {
		return undefined;
	} finally {
		ledger?.close();
	}
}

/** The reconciler's schedule: a pass soon after start (the backfill, on a first run), then hourly. Returns what stops it. */
export function startReconciler(store: Store, o: ReconcileOptions = {}): () => void {
	const first = setTimeout(() => reconcileStore(store, o), 0);
	const every = setInterval(() => reconcileStore(store, o), HOUR_MS);
	every.unref();
	return () => {
		clearTimeout(first);
		clearInterval(every);
	};
}

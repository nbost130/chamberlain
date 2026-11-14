/**
 * The Store (store.ts) on bun:sqlite: one database file, `<cache>/chamberlain.db`.
 *
 * The file is opened in WAL mode with a busy timeout and foreign keys on, so the daemon and the page can both write to it
 * at once: a writer waits for the write lock instead of failing, readers never block, and a transaction (BEGIN
 * IMMEDIATE) takes the lock when it starts, so no two read-modify-write sequences interleave. `synchronous = FULL` makes
 * every commit durable before it returns, which is what the old fsynced ledgers promised.
 *
 * Schema changes are the versioned SQL migrations in migrations.ts, each applied once inside a transaction and
 * recorded in the `migrations` table. A database whose newest migration is newer than this build's is refused.
 *
 * This file is the only writer of the notification columns of `items`: everything else asks `ItemStore.observe`, which asks
 * `decideNotification`.
 */
import { Database } from "bun:sqlite";
import type { Butler } from "./butler.ts";
import { type Db, type OpenOptions, openDatabase, queries } from "./database.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { decideNotification, NOTIFY_ONCE } from "./notification.ts";
import { HOUSEKEEPING, type RetiredHow, type Ruling } from "./rulings.ts";
import { SchemaTooNewError } from "./schema.ts";
import type {
	AwayRecord,
	Challenge,
	ChallengeVerdict,
	ClaimRecord,
	Composed,
	DecisionRow,
	Disposition,
	DispositionKey,
	DispositionWrite,
	EventQuery,
	EvidenceRow,
	HeldItem,
	Item,
	ItemFilter,
	ItemStatus,
	Lane,
	LogEvent,
	Observation,
	Observed,
	OutboxRow,
	OutboxStatus,
	RelayRecord,
	RightsStamp,
	Store,
	WakeRow,
	WakeUsage,
} from "./store.ts";

export type { OpenOptions };

/** The database was written by a newer Chamberlain than this build. */
export class DatabaseTooNewError extends SchemaTooNewError {
	constructor(path: string, found: number) {
		super(`the database ${path}`, found, LATEST_MIGRATION, "migration");
		this.name = "DatabaseTooNewError";
	}
}

type Row = Record<string, unknown>;
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(s: unknown): T | undefined => (typeof s === "string" ? (JSON.parse(s) as T) : undefined);
const mergeInto = (base: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...base, ...patch });

/** A row a query cannot fail to return (an aggregate, the sequence row a migration creates, a row just written): its absence is a broken database. */
function required(r: Row | undefined, what: string): Row {
	if (!r) throw Error(`the database has no ${what}`);
	return r;
}

/** Opens (creating and migrating) the database at `path`, or `:memory:`. */
export function openStore(path: string, o: OpenOptions = {}): Store {
	const db = openDatabase(path, o, { migrations: MIGRATIONS, tooNew: (p, found) => new DatabaseTooNewError(p, found) });
	const c = queries(db);
	return {
		path,
		tx: c.tx,
		close: () => db.close(),
		items: makeItems(c),
		claims: makeClaims(c),
		evidence: makeEvidence(c),
		rulings: makeRulings(c),
		decisions: makeDecisions(c),
		butlers: makeButlers(c),
		away: makeAway(c),
		wakes: makeWakes(c),
		challenges: makeChallenges(c),
		events: makeEvents(c),
		state: makeState(c),
		sequence: makeSequence(c),
		usage: makeUsage(c),
		dispositions: makeDispositions(c),
	};
}

// ---- items --------------------------------------------------------------------------------------
const toItem = (r: Row): Item => ({
	id: r.id as number,
	source: r.source as string,
	kind: r.kind as string,
	dedupKey: r.dedup_key as string,
	status: r.state as ItemStatus,
	mode: r.mode as Item["mode"],
	firstSeen: r.first_seen as number,
	lastSeen: r.last_seen as number,
	resolvedAt: (r.resolved_at as number | null) ?? null,
	notificationCount: r.notification_count as number,
	nextNotificationAt: (r.next_notification_at as number | null) ?? null,
	shadowNotificationCount: r.shadow_notification_count as number,
	shadowNextNotificationAt: (r.shadow_next_notification_at as number | null) ?? null,
	subject:
		r.subject_kind === null || r.subject_kind === undefined
			? null
			: { kind: r.subject_kind as string, id: r.subject_id as string },
	payload: parse<Record<string, unknown>>(r.payload) ?? {},
});
const itemRow = (c: Db, source: string, dedupKey: string) =>
	c.one("SELECT * FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
const itemId = (c: Db, source: string, dedupKey: string): number => {
	const r = c.one("SELECT id FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
	if (!r) throw Error(`no item ${source}/${dedupKey}`);
	return r.id as number;
};
/** The item as it stands now, read back inside the transaction that has just found or written it. */
const currentItem = (c: Db, source: string, dedupKey: string): Item =>
	toItem(required(itemRow(c, source, dedupKey), `item ${source}/${dedupKey}`));

function insertItem(c: Db, o: Observation, mode: string, now: number): void {
	c.run(
		"INSERT INTO items (source, kind, dedup_key, state, mode, first_seen, last_seen, subject_kind, subject_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		o.source,
		o.kind,
		o.dedupKey,
		o.baseline ? "acknowledged" : "triggered",
		mode,
		now,
		now,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		JSON.stringify(o.payload ?? {}),
	);
}

/** A recurrence is a new occurrence: its notification counters start over. */
function reopenItem(c: Db, o: Observation, id: unknown, mode: string, now: number): void {
	c.run(
		"UPDATE items SET state = ?, mode = ?, kind = ?, first_seen = ?, last_seen = ?, resolved_at = NULL, notification_count = 0, next_notification_at = NULL, shadow_notification_count = 0, shadow_next_notification_at = NULL, subject_kind = ?, subject_id = ?, payload = ? WHERE id = ?",
		o.baseline ? "acknowledged" : "triggered",
		mode,
		o.kind,
		now,
		now,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		JSON.stringify(o.payload ?? {}),
		id,
	);
}

function touchItem(c: Db, o: Observation, id: unknown, mode: string, now: number): void {
	c.run(
		"UPDATE items SET mode = ?, last_seen = ?, payload = COALESCE(?, payload), subject_kind = COALESCE(?, subject_kind), subject_id = COALESCE(?, subject_id) WHERE id = ?",
		mode,
		now,
		o.payload ? JSON.stringify(o.payload) : null,
		o.subject?.kind ?? null,
		o.subject?.id ?? null,
		id,
	);
}

/** Records what the policy decided: the live counters when it notifies, the shadow ones when it only would have. */
function recordNotification(c: Db, id: number, d: ReturnType<typeof decideNotification>): void {
	if (d.notify)
		c.run("UPDATE items SET notification_count = ?, next_notification_at = ? WHERE id = ?", d.count, d.nextAt, id);
	else if (d.wouldNotify)
		c.run(
			"UPDATE items SET shadow_notification_count = ?, shadow_next_notification_at = ? WHERE id = ?",
			d.count,
			d.nextAt,
			id,
		);
}

function observeItem(c: Db, o: Observation): Observed {
	const now = o.now ?? Date.now();
	return c.tx(() => {
		const mode = o.mode ?? "live";
		const policy = o.repeat ?? NOTIFY_ONCE;
		let created = false,
			reopened = false;
		const prior = itemRow(c, o.source, o.dedupKey);
		if (!prior) {
			created = true;
			insertItem(c, o, mode, now);
		} else if (prior.state === "resolved") {
			reopened = true;
			reopenItem(c, o, prior.id, mode, now);
		} else touchItem(c, o, prior.id, mode, now);
		const cur = currentItem(c, o.source, o.dedupKey);
		const d = decideNotification(cur, policy, now);
		recordNotification(c, cur.id, d);
		return {
			item: currentItem(c, o.source, o.dedupKey),
			created,
			reopened,
			notify: d.notify,
			wouldNotify: d.wouldNotify,
		};
	});
}

function listItems(c: Db, f: ItemFilter = {}): Item[] {
	const where: string[] = [],
		p: unknown[] = [];
	if (f.source !== undefined) {
		where.push("source = ?");
		p.push(f.source);
	}
	if (f.kind !== undefined) {
		where.push("kind = ?");
		p.push(f.kind);
	}
	if (f.status !== undefined) {
		const s = Array.isArray(f.status) ? f.status : [f.status];
		where.push(`state IN (${s.map(() => "?").join(",")})`);
		p.push(...s);
	}
	if (f.subject) {
		where.push("subject_kind = ? AND subject_id = ?");
		p.push(f.subject.kind, f.subject.id);
	}
	return c
		.all(`SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`, ...p)
		.map(toItem);
}

/** The payload of row `r` with `patch` merged over it, as the JSON the column holds. */
const patchedPayload = (r: Row, patch: Record<string, unknown>) =>
	JSON.stringify(mergeInto(parse<Record<string, unknown>>(r.payload) ?? {}, patch));

/** In one transaction: the item's row passed to `change`, then the item as it stands; undefined when there is no such item. */
function changeItem(c: Db, source: string, dedupKey: string, change: (r: Row) => void): Item | undefined {
	return c.tx(() => {
		const r = itemRow(c, source, dedupKey);
		if (!r) return undefined;
		change(r);
		return currentItem(c, source, dedupKey);
	});
}

/** Moves an item to another state with `sql` (its placeholders: the time, the merged payload, the id), when `due` says its present state allows it. */
function moveItem(
	c: Db,
	source: string,
	dedupKey: string,
	move: { sql: string; due: (state: unknown) => boolean },
	now: number,
	patch: Record<string, unknown> | undefined,
): Item | undefined {
	return changeItem(c, source, dedupKey, (r) => {
		if (move.due(r.state)) c.run(move.sql, now, patchedPayload(r, patch ?? {}), r.id);
	});
}

const resolveItem = (c: Db, source: string, dedupKey: string, now = Date.now(), patch?: Record<string, unknown>) =>
	moveItem(
		c,
		source,
		dedupKey,
		{
			sql: "UPDATE items SET state = 'resolved', resolved_at = ?, payload = ? WHERE id = ?",
			due: (state) => state !== "resolved",
		},
		now,
		patch,
	);

const acknowledgeItem = (c: Db, source: string, dedupKey: string, now = Date.now(), patch?: Record<string, unknown>) =>
	moveItem(
		c,
		source,
		dedupKey,
		{
			sql: "UPDATE items SET state = 'acknowledged', last_seen = ?, payload = ? WHERE id = ?",
			due: (state) => state === "triggered",
		},
		now,
		patch,
	);

function patchItem(c: Db, source: string, dedupKey: string, patch: Record<string, unknown>): Item | undefined {
	return changeItem(c, source, dedupKey, (r) => {
		c.run("UPDATE items SET payload = ? WHERE id = ?", patchedPayload(r, patch), r.id);
	});
}

function resolveAbsentItems(c: Db, source: string, kind: string, present: Iterable<string>, now = Date.now()): Item[] {
	const keep = new Set(present);
	return c.tx(() =>
		c
			.all("SELECT * FROM items WHERE source = ? AND kind = ? AND state != 'resolved'", source, kind)
			.filter((r) => !keep.has(r.dedup_key as string))
			.map((r) => {
				c.run("UPDATE items SET state = 'resolved', resolved_at = ? WHERE id = ?", now, r.id);
				return currentItem(c, source, r.dedup_key as string);
			}),
	);
}

function pruneItems(c: Db, before: number, keepSources = ["queue"]): number {
	const marks = keepSources.map(() => "?").join(",");
	return c.run(
		`DELETE FROM items WHERE state = 'resolved' AND last_seen < ? ${keepSources.length ? `AND source NOT IN (${marks})` : ""}`,
		before,
		...keepSources,
	).changes;
}

const makeItems = (c: Db): Store["items"] => ({
	observe: (o) => observeItem(c, o),
	get: (source, dedupKey) => {
		const r = itemRow(c, source, dedupKey);
		return r ? toItem(r) : undefined;
	},
	list: (f) => listItems(c, f),
	resolve: (source, dedupKey, now, patch) => resolveItem(c, source, dedupKey, now, patch),
	acknowledge: (source, dedupKey, now, patch) => acknowledgeItem(c, source, dedupKey, now, patch),
	patch: (source, dedupKey, patch) => patchItem(c, source, dedupKey, patch),
	resolveAbsent: (source, kind, present, now) => resolveAbsentItems(c, source, kind, present, now),
	prune: (before, keepSources) => pruneItems(c, before, keepSources),
});

// ---- claims, relays, evidence -------------------------------------------------------------------
const toClaim = (r: Row): ClaimRecord => ({
	owner: r.owner as string,
	item: r.item_key as string,
	deliveryId: r.delivery_id as string,
	message: r.message as string,
	t: r.claimed_at as string,
	...(r.answer !== null ? { answer: parse(r.answer) } : {}),
	...(r.ruling !== null ? { ruling: parse(r.ruling) } : {}),
	...(r.relay !== null ? { relay: parse(r.relay) } : {}),
});
const claimRow = (c: Db, source: string, item: string) =>
	c.one(
		"SELECT c.*, i.dedup_key AS item_key FROM claims c JOIN items i ON i.id = c.item_id WHERE i.source = ? AND i.dedup_key = ?",
		source,
		item,
	);
const toRelay = (r: Row): RelayRecord => ({
	started: true,
	...(r.outcome ? { outcome: r.outcome as "delivered" | "failed" } : {}),
	...(r.detail ? { detail: r.detail as string } : {}),
	...(r.finished_at ? { t: r.finished_at as string } : {}),
});

function claimItem(c: Db, source: string, claim: ClaimRecord): { won: boolean; claim: ClaimRecord } {
	return c.tx(() => {
		const id = itemId(c, source, claim.item);
		// Only the item's own row conflicts quietly. A delivery id already taken by another item is an error, never a lost claim.
		const r = c.run(
			"INSERT INTO claims (item_id, owner, delivery_id, message, claimed_at, answer, ruling, relay) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING",
			id,
			claim.owner,
			claim.deliveryId,
			claim.message,
			claim.t,
			json(claim.answer),
			json(claim.ruling),
			json(claim.relay),
		);
		if (r.changes === 1) return { won: true, claim };
		return {
			won: false,
			claim: toClaim(required(claimRow(c, source, claim.item), `claim for ${source}/${claim.item}`)),
		};
	});
}

const makeClaims = (c: Db): Store["claims"] => ({
	claim: (source, claim) => claimItem(c, source, claim),
	get: (source, item) => {
		const r = claimRow(c, source, item);
		return r ? toClaim(r) : undefined;
	},
	release(source, item) {
		c.run("DELETE FROM claims WHERE item_id = (SELECT id FROM items WHERE source = ? AND dedup_key = ?)", source, item);
	},
	list: (source) =>
		c
			.all(
				"SELECT c.*, i.dedup_key AS item_key FROM claims c JOIN items i ON i.id = c.item_id WHERE i.source = ? ORDER BY c.item_id",
				source,
			)
			.map(toClaim),
	startRelay(source, item, t = new Date().toISOString()) {
		return (
			c.run(
				"INSERT INTO relays (item_id, started_at) VALUES (?, ?) ON CONFLICT (item_id) DO NOTHING",
				itemId(c, source, item),
				t,
			).changes === 1
		);
	},
	finishRelay(source, item, outcome, detail, t = new Date().toISOString()) {
		c.run(
			"UPDATE relays SET outcome = ?, detail = ?, finished_at = ? WHERE item_id = ?",
			outcome,
			detail ?? null,
			t,
			itemId(c, source, item),
		);
	},
	readRelay(source, item): RelayRecord {
		const r = c.one(
			"SELECT r.* FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ? AND i.dedup_key = ?",
			source,
			item,
		);
		return r ? toRelay(r) : { started: false };
	},
	listRelays: (source) =>
		new Map(
			c
				.all(
					"SELECT r.*, i.dedup_key AS item_key FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ?",
					source,
				)
				.map((r) => [r.item_key as string, toRelay(r)]),
		),
});

const toEvidence = (r: Row): EvidenceRow => ({
	type: r.type as EvidenceRow["type"],
	...(r.name ? { name: r.name as string } : {}),
	...(r.url ? { url: r.url as string } : {}),
	...(r.caption ? { caption: r.caption as string } : {}),
});

function putEvidence(c: Db, source: string, item: string, rows: EvidenceRow[]): void {
	c.tx(() => {
		const id = itemId(c, source, item);
		c.run("DELETE FROM evidence WHERE item_id = ?", id);
		for (const [seq, e] of rows.entries())
			c.run(
				"INSERT INTO evidence (item_id, seq, type, name, url, caption) VALUES (?, ?, ?, ?, ?, ?)",
				id,
				seq,
				e.type,
				e.name ?? null,
				e.url ?? null,
				e.caption ?? null,
			);
	});
}

const makeEvidence = (c: Db): Store["evidence"] => ({
	put: (source, item, rows) => putEvidence(c, source, item, rows),
	list: (source, item) =>
		c
			.all(
				"SELECT e.* FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? AND i.dedup_key = ? ORDER BY e.seq",
				source,
				item,
			)
			.map(toEvidence),
	listAll(source) {
		const out = new Map<string, EvidenceRow[]>();
		for (const r of c.all(
			"SELECT e.*, i.dedup_key AS item_key FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? ORDER BY e.item_id, e.seq",
			source,
		))
			out.set(r.item_key as string, [...(out.get(r.item_key as string) ?? []), toEvidence(r)]);
		return out;
	},
});

// ---- rulings, decisions, butlers, away ----------------------------------------------------------
/** The fields of a ruling's retirement: when and how it was confirmed, retired and superseded. */
const retirementFields = (r: Row): Partial<Ruling> => ({
	...(r.confirmed_at ? { confirmedAt: r.confirmed_at as string } : {}),
	...(r.retired_at ? { retiredAt: r.retired_at as string } : {}),
	...(r.retired_reason || r.retired_how ? { retiredHow: (r.retired_reason ?? r.retired_how) as RetiredHow } : {}),
	...(r.retired_why ? { retiredWhy: r.retired_why as string } : {}),
	...(r.superseded_by ? { supersededBy: r.superseded_by as string } : {}),
});
/** The fields of a ruling's reach: what it supersedes, when it expires, and what it waits on. */
const reachFields = (r: Row): Partial<Ruling> => ({
	...(r.supersedes ? { supersedes: parse<string[]>(r.supersedes) } : {}),
	...(r.expires ? { expires: r.expires as string } : {}),
	...(r.until_event ? { until: r.until_event as string } : {}),
	...(r.item ? { item: r.item as string } : {}),
});
const toRuling = (r: Row): Ruling => ({
	id: r.id as string,
	date: r.date as string,
	words: r.words as string,
	decides: r.decides as string,
	source: r.source as Ruling["source"],
	status: r.status as Ruling["status"],
	confirmed: r.confirmed === 1,
	...retirementFields(r),
	...reachFields(r),
	history: parse<Ruling["history"]>(r.history) ?? [],
});

const SAVE_RULING = `INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, confirmed_at, retired_at, retired_how, retired_reason, retired_why, superseded_by, supersedes, expires, until_event, item, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET date = excluded.date, words = excluded.words, decides = excluded.decides, source = excluded.source, status = excluded.status, confirmed = excluded.confirmed,
				 confirmed_at = excluded.confirmed_at, retired_at = excluded.retired_at, retired_how = excluded.retired_how, retired_reason = excluded.retired_reason, retired_why = excluded.retired_why, superseded_by = excluded.superseded_by,
				 supersedes = excluded.supersedes, expires = excluded.expires, until_event = excluded.until_event, item = excluded.item, history = excluded.history`;

/** The columns of a saved ruling, in the order of SAVE_RULING's placeholders. */
function rulingParams(r: Ruling): unknown[] {
	// A housekeeping reason is stored as retired_how 'retired' plus retired_reason (migration 11); the page's two are retired_how alone.
	const reason = r.retiredHow && HOUSEKEEPING.has(r.retiredHow) ? r.retiredHow : null;
	return [
		r.id,
		Number(r.id.slice(1)),
		r.date,
		r.words,
		r.decides,
		r.source,
		r.status,
		r.confirmed ? 1 : 0,
		r.confirmedAt ?? null,
		r.retiredAt ?? null,
		reason ? "retired" : (r.retiredHow ?? null),
		reason,
		r.retiredWhy ?? null,
		r.supersededBy ?? null,
		r.supersedes?.length ? JSON.stringify(r.supersedes) : null,
		r.expires ?? null,
		r.until ?? null,
		r.item ?? null,
		JSON.stringify(r.history ?? []),
	];
}

const makeRulings = (c: Db): Store["rulings"] => ({
	list: () => c.all("SELECT * FROM rulings ORDER BY seq").map(toRuling),
	save(r) {
		c.run(SAVE_RULING, ...rulingParams(r));
	},
});

const toDecision = (r: Row): DecisionRow => ({
	t: r.t as string,
	thread: r.thread as string,
	decision: r.decision as string,
	ruling: r.ruling as string,
	...(r.ruling_ids ? { rulingIds: parse<string[]>(r.ruling_ids) } : {}),
	ref: (r.ref as string | null) ?? null,
});
const makeDecisions = (c: Db): Store["decisions"] => ({
	append: (d) => {
		c.run(
			"INSERT INTO decisions (t, thread, decision, ruling, ruling_ids, ref) VALUES (?, ?, ?, ?, ?, ?)",
			d.t,
			d.thread,
			d.decision,
			d.ruling,
			json(d.rulingIds),
			d.ref,
		);
	},
	list: () => c.all("SELECT * FROM decisions ORDER BY id").map(toDecision),
});

const toButler = (r: Row): Butler => ({
	id: r.id as string,
	thread: r.thread as string,
	machine: r.machine as string,
	model: r.model as string,
	scope: r.scope as string,
	started: r.started as string,
	...(r.stopped ? { stopped: r.stopped as string } : {}),
	...(r.reason ? { reason: r.reason as string } : {}),
});
const makeButlers = (c: Db): Store["butlers"] => ({
	list: () => c.all("SELECT * FROM butlers ORDER BY rowid").map(toButler),
	get: (id) => {
		const r = c.one("SELECT * FROM butlers WHERE id = ?", id);
		return r ? toButler(r) : undefined;
	},
	insert: (b) =>
		c.run(
			"INSERT INTO butlers (id, thread, machine, model, scope, started) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
			b.id,
			b.thread,
			b.machine,
			b.model,
			b.scope,
			b.started,
		).changes === 1,
	stop: (id, stopped, reason) =>
		c.run("UPDATE butlers SET stopped = ?, reason = ? WHERE id = ? AND stopped IS NULL", stopped, reason ?? null, id)
			.changes === 1,
});

const toAway = (r: Row): AwayRecord => ({
	enteredAt: r.entered_at as string,
	words: r.words as string,
	...(r.expected_return ? { expectedReturn: r.expected_return as string } : {}),
	...(r.spend_note ? { spendNote: r.spend_note as string } : {}),
});
const makeAway = (c: Db): Store["away"] => ({
	current: () => {
		const r = c.one("SELECT * FROM away WHERE exited_at IS NULL");
		return r ? toAway(r) : undefined;
	},
	enter(a) {
		c.tx(() => {
			c.run("UPDATE away SET exited_at = ? WHERE exited_at IS NULL", a.enteredAt);
			c.run(
				"INSERT INTO away (entered_at, words, expected_return, spend_note) VALUES (?, ?, ?, ?)",
				a.enteredAt,
				a.words,
				a.expectedReturn ?? null,
				a.spendNote ?? null,
			);
		});
	},
	exit(at) {
		return c.tx(() => {
			const r = c.one("SELECT * FROM away WHERE exited_at IS NULL");
			if (!r) return undefined;
			c.run("UPDATE away SET exited_at = ? WHERE id = ?", at, r.id);
			return toAway(r);
		});
	},
});

// ---- state --------------------------------------------------------------------------------------
function makeState(c: Db): Store["state"] {
	const state: Store["state"] = {
		get: <T>(key: string) => parse<T>(c.one("SELECT value FROM state WHERE key = ?", key)?.value),
		set(key, value) {
			c.run(
				"INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
				key,
				JSON.stringify(value),
				Date.now(),
			);
		},
		delete(key) {
			c.run("DELETE FROM state WHERE key = ?", key);
		},
		update: <T>(key: string, fn: (prior: T | undefined) => T | undefined) =>
			c.tx(() => {
				const next = fn(parse<T>(c.one("SELECT value FROM state WHERE key = ?", key)?.value));
				if (next === undefined) c.run("DELETE FROM state WHERE key = ?", key);
				else state.set(key, next);
				return next;
			}),
	};
	return state;
}

// ---- wakes --------------------------------------------------------------------------------------
/** The stamps a row or held item carries (migration 9): a JSON array, or nothing. Unreadable is treated as a stamp nothing matches, so the relay sends the full rights ahead of it: doubt sends them again. */
const stampsOf = (r: Row): { rights?: RightsStamp[] } => {
	if (r.rights_for === null || r.rights_for === undefined) return {};
	try {
		const v = JSON.parse(r.rights_for as string);
		if (Array.isArray(v) && v.length) return { rights: v as RightsStamp[] };
	} catch {}
	return { rights: [{ hash: "" }] };
};
const stampText = (w: { rights?: RightsStamp[] }) => (w.rights?.length ? JSON.stringify(w.rights) : null);
/** The kind, thread and receiver a wake row or held item carries, when it has them. */
const wakeTags = (r: Row): { kind?: string; thread?: string; receiver?: string } => ({
	...(r.kind ? { kind: r.kind as string } : {}),
	...(r.thread ? { thread: r.thread as string } : {}),
	...(r.receiver ? { receiver: r.receiver as string } : {}),
});
const toHeld = (r: Row): HeldItem => ({
	deliveryId: r.delivery_id as string,
	message: (r.message as string | undefined) ?? "",
	queuedAt: r.queued_at as number,
	...wakeTags(r),
	...stampsOf(r),
});
const toOutboxRow = (c: Db, r: Row): OutboxRow => ({
	id: r.id as number,
	deliveryId: r.delivery_id as string,
	message: r.message as string,
	...wakeTags(r),
	...stampsOf(r),
	createdAt: r.created_at as number,
	folded: r.folded as number,
	status: r.status as OutboxStatus,
	attempts: r.attempts as number,
	...(r.last_attempt_at !== null ? { lastAttemptAt: r.last_attempt_at as number } : {}),
	...(r.finished_at !== null ? { finishedAt: r.finished_at as number } : {}),
	members: c.all("SELECT * FROM outbox_members WHERE outbox_id = ? ORDER BY queued_at, rowid", r.id).map(toHeld),
});
// Known: bound to a row, held, or tombstoned (delivered or cancelled, even after retention deleted its row).
const knownWake = (c: Db, id: string) =>
	c.one(
		"SELECT 1 AS x FROM outbox_members WHERE delivery_id = ? UNION ALL SELECT 1 FROM held_wakes WHERE delivery_id = ? UNION ALL SELECT 1 FROM wake_tombstones WHERE delivery_id = ?",
		id,
		id,
		id,
	) !== undefined;
const findWake = (c: Db, id: string) => {
	const r = c.one(
		"SELECT o.* FROM outbox o WHERE o.delivery_id = ? OR o.id = (SELECT outbox_id FROM outbox_members WHERE delivery_id = ?)",
		id,
		id,
	);
	return r ? toOutboxRow(c, r) : undefined;
};
/** Inserts a row and binds its members, inside the caller's transaction. */
function insertRow(c: Db, w: WakeRow & { folded?: number }, members: HeldItem[]): number {
	const id = c.run(
		"INSERT INTO outbox (delivery_id, message, kind, thread, receiver, rights_for, created_at, folded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		w.deliveryId,
		w.message,
		w.kind ?? null,
		w.thread ?? null,
		w.receiver ?? null,
		stampText(w),
		w.queuedAt,
		w.folded ?? 0,
	).lastInsertRowid as number;
	for (const m of members)
		c.run(
			"INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, ?, ?)",
			m.deliveryId,
			id,
			m.queuedAt,
			m.kind ?? null,
			m.thread ?? null,
		);
	return id;
}

const heldWakes = (c: Db, lane?: Lane): HeldItem[] =>
	(lane === undefined
		? c.all("SELECT * FROM held_wakes ORDER BY seq")
		: c.all("SELECT * FROM held_wakes WHERE receiver IS ? ORDER BY seq", lane)
	).map(toHeld);

function holdWake(c: Db, w: HeldItem): boolean {
	return c.tx(() => {
		if (knownWake(c, w.deliveryId)) return false;
		c.run(
			"INSERT INTO held_wakes (delivery_id, message, queued_at, kind, thread, receiver, rights_for) VALUES (?, ?, ?, ?, ?, ?, ?)",
			w.deliveryId,
			w.message,
			w.queuedAt,
			w.kind ?? null,
			w.thread ?? null,
			w.receiver ?? null,
			stampText(w),
		);
		return true;
	});
}

function composeHeld(c: Db, now: number, compose: (held: HeldItem[]) => Composed, lane?: Lane): OutboxRow | undefined {
	return c.tx(() => {
		const held = heldWakes(c, lane);
		if (!held.length) return undefined;
		const composed = compose(held);
		const members = held.filter((h) => composed.members.includes(h.deliveryId));
		const id = insertRow(c, { ...composed, queuedAt: now }, members);
		for (const m of members) c.run("DELETE FROM held_wakes WHERE delivery_id = ?", m.deliveryId);
		return toOutboxRow(c, required(c.one("SELECT * FROM outbox WHERE id = ?", id), `outbox row ${id}`));
	});
}

function outboxRows(c: Db, status: OutboxStatus | "all" = "pending", lane?: Lane): OutboxRow[] {
	return (
		lane === undefined
			? status === "all"
				? c.all("SELECT * FROM outbox ORDER BY id")
				: c.all("SELECT * FROM outbox WHERE status = ? ORDER BY id", status)
			: status === "all"
				? c.all("SELECT * FROM outbox WHERE receiver IS ? ORDER BY id", lane)
				: c.all("SELECT * FROM outbox WHERE status = ? AND receiver IS ? ORDER BY id", status, lane)
	).map((r) => toOutboxRow(c, r));
}

function retryWake(c: Db, id: string): OutboxStatus | undefined {
	return c.tx(() => {
		const r = findWake(c, id);
		if (r?.status === "dead_letter")
			c.run(
				"UPDATE outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, finished_at = NULL WHERE id = ?",
				r.id,
			);
		return r?.status;
	});
}

function cancelWake(c: Db, id: string, now: number): OutboxStatus | undefined {
	return c.tx(() => {
		const r = findWake(c, id);
		if (r && (r.status === "pending" || r.status === "dead_letter"))
			c.run("UPDATE outbox SET status = 'cancelled', finished_at = ? WHERE id = ?", now, r.id);
		return r?.status;
	});
}

const makeWakes = (c: Db): Store["wakes"] => ({
	enqueue: (w) =>
		c.tx(() => {
			if (knownWake(c, w.deliveryId)) return false;
			insertRow(c, w, [w]);
			return true;
		}),
	hold: (w) => holdWake(c, w),
	held: (lane) => heldWakes(c, lane),
	compose: (now, compose, lane) => composeHeld(c, now, compose, lane),
	rows: (status, lane) => outboxRows(c, status, lane),
	find: (id) => findWake(c, id),
	isDelivered: (id) =>
		(findWake(c, id)?.status ??
			(c.one("SELECT outcome FROM wake_tombstones WHERE delivery_id = ?", id)?.outcome as string | undefined)) ===
		"delivered",
	known: (id) => knownWake(c, id),
	beginAttempt: (id, now) =>
		c.one(
			"UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'pending' RETURNING attempts",
			now,
			id,
		)?.attempts as number | undefined,
	finish: (id, status, now) =>
		c.run("UPDATE outbox SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'", status, now, id)
			.changes === 1,
	retry: (id) => retryWake(c, id),
	cancel: (id, now) => cancelWake(c, id, now),
	// Only a terminal row goes: a delivered or cancelled row that no unresolved claim still names. Its ids stay in wake_tombstones (migration 7), which is what stops them being enqueued again.
	prune: (before) =>
		c.run(
			`DELETE FROM outbox WHERE status IN ('delivered', 'cancelled') AND finished_at < ?
				 AND id NOT IN (SELECT m.outbox_id FROM outbox_members m JOIN claims c ON c.delivery_id = m.delivery_id JOIN items i ON i.id = c.item_id WHERE i.state != 'resolved')`,
			before,
		).changes,
});

// ---- confirmation challenges --------------------------------------------------------------------
function issueChallenge(c: Db, ch: Challenge): void {
	c.tx(() => {
		c.run(
			"DELETE FROM confirmation_challenges WHERE card_id = ? AND session_hash = ? AND consumed_at IS NULL",
			ch.cardId,
			ch.sessionHash,
		);
		c.run(
			"INSERT INTO confirmation_challenges (token_hash, card_id, sig, choice, session_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			ch.tokenHash,
			ch.cardId,
			ch.sig,
			ch.choice,
			ch.sessionHash,
			ch.issuedAt,
			ch.expiresAt,
		);
	});
}

function consumeChallenge(
	c: Db,
	tokenHash: string,
	expect: { cardId: string; sig: string; choice: number; sessionHash: string },
	now: number,
): ChallengeVerdict {
	return c.tx(() => {
		const r = c.one("SELECT * FROM confirmation_challenges WHERE token_hash = ?", tokenHash);
		if (!r) return "unknown";
		if (r.consumed_at !== null) return "used";
		if ((r.expires_at as number) <= now) return "expired";
		if (
			r.card_id !== expect.cardId ||
			r.sig !== expect.sig ||
			r.choice !== expect.choice ||
			r.session_hash !== expect.sessionHash
		)
			return "mismatch";
		c.run(
			"UPDATE confirmation_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
			now,
			tokenHash,
		);
		return "ok";
	});
}

const makeChallenges = (c: Db): Store["challenges"] => ({
	issue: (ch) => issueChallenge(c, ch),
	consume: (tokenHash, expect, now) => consumeChallenge(c, tokenHash, expect, now),
	prune: (before) =>
		c.run(
			"DELETE FROM confirmation_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)",
			before,
			before,
		).changes,
});

// ---- events -------------------------------------------------------------------------------------
const toEvent = (r: Row): LogEvent => ({
	t: r.t as string,
	...(r.src ? { src: r.src as string } : {}),
	...(parse<Record<string, unknown>>(r.data) ?? {}),
	event: r.event as string,
});
const eventWhere = (q: EventQuery) => {
	const where: string[] = [],
		p: unknown[] = [];
	if (q.since !== undefined) {
		where.push("t >= ?");
		p.push(q.since);
	}
	if (q.until !== undefined) {
		where.push("t < ?");
		p.push(q.until);
	}
	if (q.events?.length) {
		where.push(`event IN (${q.events.map(() => "?").join(",")})`);
		p.push(...q.events);
	}
	if (q.src !== undefined) {
		where.push("src = ?");
		p.push(q.src);
	}
	return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", p };
};
const makeEvents = (c: Db): Store["events"] => ({
	append(e, importKey) {
		const { t, event, src, ...data } = e;
		c.run(
			"INSERT INTO events (t, event, src, data, import_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT (import_key) DO NOTHING",
			t,
			event,
			src ?? null,
			JSON.stringify(data),
			importKey ?? null,
		);
	},
	query(q = {}) {
		const w = eventWhere(q);
		return c
			.all(`SELECT * FROM events ${w.sql} ORDER BY id ${q.limit ? `LIMIT ${Math.floor(q.limit)}` : ""}`, ...w.p)
			.map(toEvent);
	},
	count: (q = {}) => {
		const w = eventWhere(q);
		return required(c.one(`SELECT COUNT(*) AS n FROM events ${w.sql}`, ...w.p), "event count").n as number;
	},
	prune: (before) => c.run("DELETE FROM events WHERE t < ?", before).changes,
});

// ---- the sequence (migration 12) -------------------------------------------------------------------
const makeSequence = (c: Db): Store["sequence"] => ({
	next: () =>
		c.tx(
			() =>
				required(c.one("UPDATE store_sequence SET value = value + 1 WHERE id = 1 RETURNING value"), "store sequence")
					.value as number,
		),
	current: () => required(c.one("SELECT value FROM store_sequence WHERE id = 1"), "store sequence").value as number,
});

// ---- the classifier's dispositions (migration 13) ---------------------------------------------------
const KEY_WHERE = "server = ? AND thread_id = ? AND message_hash = ? AND bank_version = ?";
const keyArgs = (k: DispositionKey) => [k.server, k.threadId, k.messageHash, k.bankVersion];
const toDisposition = (r: Row): Disposition => ({
	server: r.server as string,
	threadId: r.thread_id as string,
	messageHash: r.message_hash as string,
	bankVersion: r.bank_version as string,
	classifiedAt: r.classified_at as number,
	provider: r.provider as Disposition["provider"],
	model: (r.model as string | null) ?? null,
	mode: r.mode as Disposition["mode"],
	action: r.action as Disposition["action"],
	reasons: parse<string[]>(r.reasons) ?? [],
	answers: parse<Record<string, number>>(r.answers) ?? {},
	idleMinutes: r.idle_minutes as number,
	sentChars: r.sent_chars as number,
	redactions: r.redactions as number,
	inputTokens: (r.input_tokens as number | null) ?? null,
	costUsd: (r.cost_usd as number | null) ?? null,
	latencyMs: (r.latency_ms as number | null) ?? null,
	error: (r.error as string | null) ?? null,
	feedback: (r.feedback as Disposition["feedback"]) ?? null,
	correctedAction: (r.corrected_action as Disposition["correctedAction"]) ?? null,
});

function putDisposition(c: Db, d: DispositionWrite): void {
	c.run(
		`INSERT INTO thread_dispositions (server, thread_id, message_hash, bank_version, classified_at, provider, model, mode, action,
						reasons, answers, idle_minutes, sent_chars, redactions, input_tokens, cost_usd, latency_ms, error)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (server, thread_id, message_hash, bank_version) DO UPDATE SET classified_at = excluded.classified_at,
						provider = excluded.provider, model = excluded.model, mode = excluded.mode, action = excluded.action,
						reasons = excluded.reasons, answers = excluded.answers, idle_minutes = excluded.idle_minutes,
						sent_chars = excluded.sent_chars, redactions = excluded.redactions, input_tokens = excluded.input_tokens,
						cost_usd = excluded.cost_usd, latency_ms = excluded.latency_ms, error = excluded.error`,
		...keyArgs(d),
		d.classifiedAt,
		d.provider,
		d.model,
		d.mode,
		d.action,
		JSON.stringify(d.reasons),
		JSON.stringify(d.answers),
		Math.floor(d.idleMinutes),
		d.sentChars,
		d.redactions,
		d.inputTokens,
		d.costUsd,
		d.latencyMs,
		d.error,
	);
}

function dispositionUsage(c: Db, since: number, providers: readonly string[]): { calls: number; usd: number } {
	if (!providers.length) return { calls: 0, usd: 0 };
	const r = required(
		c.one(
			`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM thread_dispositions
					WHERE classified_at >= ? AND provider IN (${providers.map(() => "?").join(",")})`,
			since,
			...providers,
		),
		"disposition usage",
	);
	return { calls: r.n as number, usd: r.usd as number };
}

const makeDispositions = (c: Db): Store["dispositions"] => ({
	get: (k) => {
		const r = c.one(`SELECT * FROM thread_dispositions WHERE ${KEY_WHERE}`, ...keyArgs(k));
		return r ? toDisposition(r) : undefined;
	},
	put: (d) => putDisposition(c, d),
	redecide(k, o) {
		c.run(
			`UPDATE thread_dispositions SET action = ?, reasons = ?, idle_minutes = ?, mode = ? WHERE ${KEY_WHERE} AND action != 'unknown'`,
			o.action,
			JSON.stringify(o.reasons),
			Math.floor(o.idleMinutes),
			o.mode,
			...keyArgs(k),
		);
	},
	usage: (since, providers) => dispositionUsage(c, since, providers),
	feedback: (k, feedback, corrected) =>
		c.run(
			`UPDATE thread_dispositions SET feedback = ?, corrected_action = ? WHERE ${KEY_WHERE}`,
			feedback,
			corrected ?? null,
			...keyArgs(k),
		).changes > 0,
	prune: (before) =>
		c.run("DELETE FROM thread_dispositions WHERE classified_at < ? AND feedback IS NULL", before).changes,
});

// ---- the Steward's token usage per wake ----------------------------------------------------------------
const UPSERT_USAGE = `INSERT INTO steward_wake_usage (session, wake_key, kind, variant, delivery_id, started_at, ended_at, requests, input_tokens,
								cache_read_input_tokens, cache_creation_input_tokens, output_tokens, context_start, context_end, context_peak, compactions)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT (session, wake_key) DO UPDATE SET kind = excluded.kind, variant = excluded.variant, delivery_id = excluded.delivery_id,
								started_at = excluded.started_at, ended_at = excluded.ended_at, requests = excluded.requests, input_tokens = excluded.input_tokens,
								cache_read_input_tokens = excluded.cache_read_input_tokens, cache_creation_input_tokens = excluded.cache_creation_input_tokens,
								output_tokens = excluded.output_tokens, context_start = excluded.context_start, context_end = excluded.context_end,
								context_peak = excluded.context_peak, compactions = excluded.compactions`;

const usageParams = (r: WakeUsage): unknown[] => [
	r.session,
	r.wakeKey,
	r.kind,
	r.variant ?? null,
	r.deliveryId ?? null,
	r.startedAt,
	r.endedAt,
	r.requests,
	r.inputTokens,
	r.cacheReadInputTokens,
	r.cacheCreationInputTokens,
	r.outputTokens,
	r.contextStart ?? null,
	r.contextEnd ?? null,
	r.contextPeak ?? null,
	r.compactions,
];

const toWakeUsage = (r: Row): WakeUsage => {
	const opt = (v: unknown) => (v === null || v === undefined ? undefined : (v as number));
	const w: WakeUsage = {
		session: r.session as string,
		wakeKey: r.wake_key as string,
		kind: r.kind as string,
		startedAt: r.started_at as number,
		endedAt: r.ended_at as number,
		requests: r.requests as number,
		inputTokens: r.input_tokens as number,
		cacheReadInputTokens: r.cache_read_input_tokens as number,
		cacheCreationInputTokens: r.cache_creation_input_tokens as number,
		outputTokens: r.output_tokens as number,
		compactions: r.compactions as number,
	};
	if (r.variant !== null) w.variant = r.variant as string;
	if (r.delivery_id !== null) w.deliveryId = r.delivery_id as string;
	for (const [key, col] of [
		["contextStart", "context_start"],
		["contextEnd", "context_end"],
		["contextPeak", "context_peak"],
	] as const) {
		const v = opt(r[col]);
		if (v !== undefined) w[key] = v;
	}
	return w;
};

function listUsage(c: Db, q: { since?: number; session?: string } = {}): WakeUsage[] {
	const where: string[] = [],
		p: unknown[] = [];
	if (q.since !== undefined) {
		where.push("started_at >= ?");
		p.push(q.since);
	}
	if (q.session !== undefined) {
		where.push("session = ?");
		p.push(q.session);
	}
	return c
		.all(
			`SELECT * FROM steward_wake_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at, session, wake_key`,
			...p,
		)
		.map(toWakeUsage);
}

const makeUsage = (c: Db): Store["usage"] => ({
	upsert(rows: WakeUsage[]) {
		c.tx(() => {
			for (const r of rows) c.run(UPSERT_USAGE, ...usageParams(r));
		});
	},
	list: (q) => listUsage(c, q),
});

/**
 * Folds a database's write-ahead log into its main file (a TRUNCATE checkpoint) and closes it, so the one file can be moved
 * or copied whole. False when another process has the database open and the log could not be folded. Does not migrate.
 */
export function foldWal(path: string, busyMs = 5000): boolean {
	const db = new Database(path);
	try {
		db.exec(`PRAGMA busy_timeout = ${busyMs}`);
		const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
		return !r || r.busy === 0;
	} finally {
		db.close();
	}
}

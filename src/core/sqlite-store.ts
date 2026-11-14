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
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Butler } from "./butler.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { decideNotification, NOTIFY_ONCE } from "./notification.ts";
import { DIR_MODE, enforceMode, FILE_MODE } from "./private.ts";
import { HOUSEKEEPING, type RetiredHow, type Ruling } from "./rulings.ts";
import { SchemaTooNewError } from "./schema.ts";
import type {
	AwayRecord,
	Challenge,
	ChallengeVerdict,
	ClaimRecord,
	DecisionRow,
	EventQuery,
	EvidenceRow,
	HeldItem,
	Item,
	ItemFilter,
	ItemStatus,
	LogEvent,
	Observation,
	Observed,
	OutboxRow,
	OutboxStatus,
	RelayRecord,
	RightsStamp,
	Store,
	WakeRow,
} from "./store.ts";

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
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const mergeInto = (base: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...base, ...patch });

export type OpenOptions = {
	/** How long a writer waits for another process's write lock before giving up. Default 10 seconds. */
	busyMs?: number;
	/** How a mode is set (default fs.chmodSync). A seam for tests: whatever it does, the mode is read back and must be right. */
	chmod?: (path: string, mode: number) => void;
};

/** Opens (creating and migrating) the database at `path`, or `:memory:`. */
export function openStore(path: string, o: OpenOptions = {}): Store {
	const memory = path === ":memory:";
	if (!memory) {
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		// Private before anything else: the directory 0700 and the file 0600, each CHECKED after the chmod. A mode that cannot be set
		// (not our file, a filesystem without modes) is a refusal to start, never a database anyone else can read. The file exists and is 0600
		// before SQLite makes its own -wal and -shm files, which copy the main file's mode.
		enforceMode(dir, DIR_MODE, "the state directory", o.chmod);
		closeSync(openSync(path, "a", FILE_MODE));
		enforceMode(path, FILE_MODE, "the database", o.chmod);
	}
	const db = new Database(path, { create: true });
	// The timeout first: switching to WAL takes a lock another process may hold.
	db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(o.busyMs ?? 10_000))}`);
	if (!memory) db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = FULL");
	try {
		migrate(db, path);
	} catch (e) {
		db.close();
		throw e;
	}

	// ---- transactions -------------------------------------------------------------------------------
	let depth = 0;
	function tx<T>(fn: () => T): T {
		if (depth === 0) {
			db.exec("BEGIN IMMEDIATE");
			depth = 1;
			try {
				const out = fn();
				if (out && typeof (out as { then?: unknown }).then === "function")
					throw Error("a store transaction cannot await");
				db.exec("COMMIT");
				return out;
			} catch (e) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* the transaction already ended */
				}
				throw e;
			} finally {
				depth = 0;
			}
		}
		const name = `sp${depth}`;
		db.exec(`SAVEPOINT ${name}`);
		depth++;
		try {
			const out = fn();
			db.exec(`RELEASE ${name}`);
			return out;
		} catch (e) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw e;
		} finally {
			depth--;
		}
	}
	const all = (sql: string, ...p: unknown[]) => db.query(sql).all(...(p as never[])) as Row[];
	const one = (sql: string, ...p: unknown[]) => (db.query(sql).get(...(p as never[])) ?? undefined) as Row | undefined;
	const run = (sql: string, ...p: unknown[]) => db.query(sql).run(...(p as never[]));

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
	const itemRow = (source: string, dedupKey: string) =>
		one("SELECT * FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
	const itemId = (source: string, dedupKey: string): number => {
		const r = one("SELECT id FROM items WHERE source = ? AND dedup_key = ?", source, dedupKey);
		if (!r) throw Error(`no item ${source}/${dedupKey}`);
		return r.id as number;
	};

	const items: Store["items"] = {
		observe(o: Observation): Observed {
			const now = o.now ?? Date.now();
			return tx(() => {
				const mode = o.mode ?? "live";
				const policy = o.repeat ?? NOTIFY_ONCE;
				let created = false,
					reopened = false;
				const prior = itemRow(o.source, o.dedupKey);
				if (!prior) {
					created = true;
					run(
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
				} else if (prior.state === "resolved") {
					// A recurrence is a new occurrence: its notification counters start over.
					reopened = true;
					run(
						"UPDATE items SET state = ?, mode = ?, kind = ?, first_seen = ?, last_seen = ?, resolved_at = NULL, notification_count = 0, next_notification_at = NULL, shadow_notification_count = 0, shadow_next_notification_at = NULL, subject_kind = ?, subject_id = ?, payload = ? WHERE id = ?",
						o.baseline ? "acknowledged" : "triggered",
						mode,
						o.kind,
						now,
						now,
						o.subject?.kind ?? null,
						o.subject?.id ?? null,
						JSON.stringify(o.payload ?? {}),
						prior.id,
					);
				} else {
					run(
						"UPDATE items SET mode = ?, last_seen = ?, payload = COALESCE(?, payload), subject_kind = COALESCE(?, subject_kind), subject_id = COALESCE(?, subject_id) WHERE id = ?",
						mode,
						now,
						o.payload ? JSON.stringify(o.payload) : null,
						o.subject?.kind ?? null,
						o.subject?.id ?? null,
						prior.id,
					);
				}
				const cur = toItem(itemRow(o.source, o.dedupKey)!);
				const d = decideNotification(cur, policy, now);
				if (d.notify)
					run(
						"UPDATE items SET notification_count = ?, next_notification_at = ? WHERE id = ?",
						d.count,
						d.nextAt,
						cur.id,
					);
				else if (d.wouldNotify)
					run(
						"UPDATE items SET shadow_notification_count = ?, shadow_next_notification_at = ? WHERE id = ?",
						d.count,
						d.nextAt,
						cur.id,
					);
				return {
					item: toItem(itemRow(o.source, o.dedupKey)!),
					created,
					reopened,
					notify: d.notify,
					wouldNotify: d.wouldNotify,
				};
			});
		},
		get: (source, dedupKey) => {
			const r = itemRow(source, dedupKey);
			return r ? toItem(r) : undefined;
		},
		list(f: ItemFilter = {}) {
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
			return all(`SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`, ...p).map(
				toItem,
			);
		},
		resolve(source, dedupKey, now = Date.now(), patch) {
			return tx(() => {
				const r = itemRow(source, dedupKey);
				if (!r) return undefined;
				if (r.state !== "resolved")
					run(
						"UPDATE items SET state = 'resolved', resolved_at = ?, payload = ? WHERE id = ?",
						now,
						JSON.stringify(mergeInto(parse<Record<string, unknown>>(r.payload) ?? {}, patch ?? {})),
						r.id,
					);
				return toItem(itemRow(source, dedupKey)!);
			});
		},
		acknowledge(source, dedupKey, now = Date.now(), patch) {
			return tx(() => {
				const r = itemRow(source, dedupKey);
				if (!r) return undefined;
				if (r.state === "triggered")
					run(
						"UPDATE items SET state = 'acknowledged', last_seen = ?, payload = ? WHERE id = ?",
						now,
						JSON.stringify(mergeInto(parse<Record<string, unknown>>(r.payload) ?? {}, patch ?? {})),
						r.id,
					);
				return toItem(itemRow(source, dedupKey)!);
			});
		},
		patch(source, dedupKey, patch) {
			return tx(() => {
				const r = itemRow(source, dedupKey);
				if (!r) return undefined;
				run(
					"UPDATE items SET payload = ? WHERE id = ?",
					JSON.stringify(mergeInto(parse<Record<string, unknown>>(r.payload) ?? {}, patch)),
					r.id,
				);
				return toItem(itemRow(source, dedupKey)!);
			});
		},
		resolveAbsent(source, kind, present, now = Date.now()) {
			const keep = new Set(present);
			return tx(() =>
				all("SELECT * FROM items WHERE source = ? AND kind = ? AND state != 'resolved'", source, kind)
					.filter((r) => !keep.has(r.dedup_key as string))
					.map((r) => {
						run("UPDATE items SET state = 'resolved', resolved_at = ? WHERE id = ?", now, r.id);
						return toItem(itemRow(source, r.dedup_key as string)!);
					}),
			);
		},
		prune(before, keepSources = ["queue"]) {
			const marks = keepSources.map(() => "?").join(",");
			return run(
				`DELETE FROM items WHERE state = 'resolved' AND last_seen < ? ${keepSources.length ? `AND source NOT IN (${marks})` : ""}`,
				before,
				...keepSources,
			).changes;
		},
	};

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
	const claimRow = (source: string, item: string) =>
		one(
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
	const claims: Store["claims"] = {
		claim(source, c) {
			return tx(() => {
				const id = itemId(source, c.item);
				// Only the item's own row conflicts quietly. A delivery id already taken by another item is an error, never a lost claim.
				const r = run(
					"INSERT INTO claims (item_id, owner, delivery_id, message, claimed_at, answer, ruling, relay) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING",
					id,
					c.owner,
					c.deliveryId,
					c.message,
					c.t,
					json(c.answer),
					json(c.ruling),
					json(c.relay),
				);
				if (r.changes === 1) return { won: true, claim: c };
				return { won: false, claim: toClaim(claimRow(source, c.item)!) };
			});
		},
		get: (source, item) => {
			const r = claimRow(source, item);
			return r ? toClaim(r) : undefined;
		},
		release(source, item) {
			run("DELETE FROM claims WHERE item_id = (SELECT id FROM items WHERE source = ? AND dedup_key = ?)", source, item);
		},
		list: (source) =>
			all(
				"SELECT c.*, i.dedup_key AS item_key FROM claims c JOIN items i ON i.id = c.item_id WHERE i.source = ? ORDER BY c.item_id",
				source,
			).map(toClaim),
		startRelay(source, item, t = new Date().toISOString()) {
			return (
				run(
					"INSERT INTO relays (item_id, started_at) VALUES (?, ?) ON CONFLICT (item_id) DO NOTHING",
					itemId(source, item),
					t,
				).changes === 1
			);
		},
		finishRelay(source, item, outcome, detail, t = new Date().toISOString()) {
			run(
				"UPDATE relays SET outcome = ?, detail = ?, finished_at = ? WHERE item_id = ?",
				outcome,
				detail ?? null,
				t,
				itemId(source, item),
			);
		},
		readRelay(source, item): RelayRecord {
			const r = one(
				"SELECT r.* FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ? AND i.dedup_key = ?",
				source,
				item,
			);
			return r ? toRelay(r) : { started: false };
		},
		listRelays: (source) =>
			new Map(
				all(
					"SELECT r.*, i.dedup_key AS item_key FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ?",
					source,
				).map((r) => [r.item_key as string, toRelay(r)]),
			),
	};

	const toEvidence = (r: Row): EvidenceRow => ({
		type: r.type as EvidenceRow["type"],
		...(r.name ? { name: r.name as string } : {}),
		...(r.url ? { url: r.url as string } : {}),
		...(r.caption ? { caption: r.caption as string } : {}),
	});
	const evidence: Store["evidence"] = {
		put(source, item, rows) {
			tx(() => {
				const id = itemId(source, item);
				run("DELETE FROM evidence WHERE item_id = ?", id);
				rows.forEach((e, seq) =>
					run(
						"INSERT INTO evidence (item_id, seq, type, name, url, caption) VALUES (?, ?, ?, ?, ?, ?)",
						id,
						seq,
						e.type,
						e.name ?? null,
						e.url ?? null,
						e.caption ?? null,
					),
				);
			});
		},
		list: (source, item) =>
			all(
				"SELECT e.* FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? AND i.dedup_key = ? ORDER BY e.seq",
				source,
				item,
			).map(toEvidence),
		listAll(source) {
			const out = new Map<string, EvidenceRow[]>();
			for (const r of all(
				"SELECT e.*, i.dedup_key AS item_key FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? ORDER BY e.item_id, e.seq",
				source,
			))
				out.set(r.item_key as string, [...(out.get(r.item_key as string) ?? []), toEvidence(r)]);
			return out;
		},
	};

	// ---- rulings, decisions, butlers, away ----------------------------------------------------------
	const toRuling = (r: Row): Ruling => ({
		id: r.id as string,
		date: r.date as string,
		words: r.words as string,
		decides: r.decides as string,
		source: r.source as Ruling["source"],
		status: r.status as Ruling["status"],
		confirmed: r.confirmed === 1,
		...(r.confirmed_at ? { confirmedAt: r.confirmed_at as string } : {}),
		...(r.retired_at ? { retiredAt: r.retired_at as string } : {}),
		...(r.retired_reason || r.retired_how ? { retiredHow: (r.retired_reason ?? r.retired_how) as RetiredHow } : {}),
		...(r.retired_why ? { retiredWhy: r.retired_why as string } : {}),
		...(r.superseded_by ? { supersededBy: r.superseded_by as string } : {}),
		...(r.supersedes ? { supersedes: parse<string[]>(r.supersedes) } : {}),
		...(r.expires ? { expires: r.expires as string } : {}),
		...(r.until_event ? { until: r.until_event as string } : {}),
		...(r.item ? { item: r.item as string } : {}),
		history: parse<Ruling["history"]>(r.history) ?? [],
	});
	const rulings: Store["rulings"] = {
		list: () => all("SELECT * FROM rulings ORDER BY seq").map(toRuling),
		save(r) {
			// A housekeeping reason is stored as retired_how 'retired' plus retired_reason (migration 11); the page's two are retired_how alone.
			const reason = r.retiredHow && HOUSEKEEPING.has(r.retiredHow) ? r.retiredHow : null;
			run(
				`INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, confirmed_at, retired_at, retired_how, retired_reason, retired_why, superseded_by, supersedes, expires, until_event, item, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET date = excluded.date, words = excluded.words, decides = excluded.decides, source = excluded.source, status = excluded.status, confirmed = excluded.confirmed,
				 confirmed_at = excluded.confirmed_at, retired_at = excluded.retired_at, retired_how = excluded.retired_how, retired_reason = excluded.retired_reason, retired_why = excluded.retired_why, superseded_by = excluded.superseded_by,
				 supersedes = excluded.supersedes, expires = excluded.expires, until_event = excluded.until_event, item = excluded.item, history = excluded.history`,
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
			);
		},
	};

	const decisions: Store["decisions"] = {
		append: (d) => {
			run(
				"INSERT INTO decisions (t, thread, decision, ruling, ruling_ids, ref) VALUES (?, ?, ?, ?, ?, ?)",
				d.t,
				d.thread,
				d.decision,
				d.ruling,
				json(d.rulingIds),
				d.ref,
			);
		},
		list: () =>
			all("SELECT * FROM decisions ORDER BY id").map(
				(r): DecisionRow => ({
					t: r.t as string,
					thread: r.thread as string,
					decision: r.decision as string,
					ruling: r.ruling as string,
					...(r.ruling_ids ? { rulingIds: parse<string[]>(r.ruling_ids) } : {}),
					ref: (r.ref as string | null) ?? null,
				}),
			),
	};

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
	const butlers: Store["butlers"] = {
		list: () => all("SELECT * FROM butlers ORDER BY rowid").map(toButler),
		get: (id) => {
			const r = one("SELECT * FROM butlers WHERE id = ?", id);
			return r ? toButler(r) : undefined;
		},
		insert: (b) =>
			run(
				"INSERT INTO butlers (id, thread, machine, model, scope, started) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
				b.id,
				b.thread,
				b.machine,
				b.model,
				b.scope,
				b.started,
			).changes === 1,
		stop: (id, stopped, reason) =>
			run("UPDATE butlers SET stopped = ?, reason = ? WHERE id = ? AND stopped IS NULL", stopped, reason ?? null, id)
				.changes === 1,
	};

	const toAway = (r: Row): AwayRecord => ({
		enteredAt: r.entered_at as string,
		words: r.words as string,
		...(r.expected_return ? { expectedReturn: r.expected_return as string } : {}),
		...(r.spend_note ? { spendNote: r.spend_note as string } : {}),
	});
	const away: Store["away"] = {
		current: () => {
			const r = one("SELECT * FROM away WHERE exited_at IS NULL");
			return r ? toAway(r) : undefined;
		},
		enter(a) {
			tx(() => {
				run("UPDATE away SET exited_at = ? WHERE exited_at IS NULL", a.enteredAt);
				run(
					"INSERT INTO away (entered_at, words, expected_return, spend_note) VALUES (?, ?, ?, ?)",
					a.enteredAt,
					a.words,
					a.expectedReturn ?? null,
					a.spendNote ?? null,
				);
			});
		},
		exit(at) {
			return tx(() => {
				const r = one("SELECT * FROM away WHERE exited_at IS NULL");
				if (!r) return undefined;
				run("UPDATE away SET exited_at = ? WHERE id = ?", at, r.id);
				return toAway(r);
			});
		},
	};

	// ---- state --------------------------------------------------------------------------------------
	const state: Store["state"] = {
		get: <T>(key: string) => parse<T>(one("SELECT value FROM state WHERE key = ?", key)?.value),
		set(key, value) {
			run(
				"INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
				key,
				JSON.stringify(value),
				Date.now(),
			);
		},
		delete(key) {
			run("DELETE FROM state WHERE key = ?", key);
		},
		update: <T>(key: string, fn: (prior: T | undefined) => T | undefined) =>
			tx(() => {
				const next = fn(parse<T>(one("SELECT value FROM state WHERE key = ?", key)?.value));
				if (next === undefined) run("DELETE FROM state WHERE key = ?", key);
				else state.set(key, next);
				return next;
			}),
	};

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
	const toHeld = (r: Row): HeldItem => ({
		deliveryId: r.delivery_id as string,
		message: (r.message as string | undefined) ?? "",
		queuedAt: r.queued_at as number,
		...(r.kind ? { kind: r.kind as string } : {}),
		...(r.thread ? { thread: r.thread as string } : {}),
		...(r.receiver ? { receiver: r.receiver as string } : {}),
		...stampsOf(r),
	});
	const toRow = (r: Row): OutboxRow => ({
		id: r.id as number,
		deliveryId: r.delivery_id as string,
		message: r.message as string,
		...(r.kind ? { kind: r.kind as string } : {}),
		...(r.thread ? { thread: r.thread as string } : {}),
		...(r.receiver ? { receiver: r.receiver as string } : {}),
		...stampsOf(r),
		createdAt: r.created_at as number,
		folded: r.folded as number,
		status: r.status as OutboxStatus,
		attempts: r.attempts as number,
		...(r.last_attempt_at !== null ? { lastAttemptAt: r.last_attempt_at as number } : {}),
		...(r.finished_at !== null ? { finishedAt: r.finished_at as number } : {}),
		members: all("SELECT * FROM outbox_members WHERE outbox_id = ? ORDER BY queued_at, rowid", r.id).map(toHeld),
	});
	// Known: bound to a row, held, or tombstoned (delivered or cancelled, even after retention deleted its row).
	const known = (id: string) =>
		one(
			"SELECT 1 AS x FROM outbox_members WHERE delivery_id = ? UNION ALL SELECT 1 FROM held_wakes WHERE delivery_id = ? UNION ALL SELECT 1 FROM wake_tombstones WHERE delivery_id = ?",
			id,
			id,
			id,
		) !== undefined;
	const find = (id: string) => {
		const r = one(
			"SELECT o.* FROM outbox o WHERE o.delivery_id = ? OR o.id = (SELECT outbox_id FROM outbox_members WHERE delivery_id = ?)",
			id,
			id,
		);
		return r ? toRow(r) : undefined;
	};
	/** Inserts a row and binds its members, inside the caller's transaction. */
	function insertRow(w: WakeRow & { folded?: number }, members: HeldItem[]): number {
		const id = run(
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
			run(
				"INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, ?, ?)",
				m.deliveryId,
				id,
				m.queuedAt,
				m.kind ?? null,
				m.thread ?? null,
			);
		return id;
	}
	const wakes: Store["wakes"] = {
		enqueue: (w) =>
			tx(() => {
				if (known(w.deliveryId)) return false;
				insertRow(w, [w]);
				return true;
			}),
		hold: (w) =>
			tx(() => {
				if (known(w.deliveryId)) return false;
				run(
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
			}),
		held: (lane) =>
			(lane === undefined
				? all("SELECT * FROM held_wakes ORDER BY seq")
				: all("SELECT * FROM held_wakes WHERE receiver IS ? ORDER BY seq", lane)
			).map(toHeld),
		compose: (now, compose, lane) =>
			tx(() => {
				const held = wakes.held(lane);
				if (!held.length) return undefined;
				const c = compose(held);
				const members = held.filter((h) => c.members.includes(h.deliveryId));
				const id = insertRow({ ...c, queuedAt: now }, members);
				for (const m of members) run("DELETE FROM held_wakes WHERE delivery_id = ?", m.deliveryId);
				return toRow(one("SELECT * FROM outbox WHERE id = ?", id)!);
			}),
		rows: (status = "pending", lane) =>
			(lane === undefined
				? status === "all"
					? all("SELECT * FROM outbox ORDER BY id")
					: all("SELECT * FROM outbox WHERE status = ? ORDER BY id", status)
				: status === "all"
					? all("SELECT * FROM outbox WHERE receiver IS ? ORDER BY id", lane)
					: all("SELECT * FROM outbox WHERE status = ? AND receiver IS ? ORDER BY id", status, lane)
			).map(toRow),
		find,
		isDelivered: (id) =>
			(find(id)?.status ??
				(one("SELECT outcome FROM wake_tombstones WHERE delivery_id = ?", id)?.outcome as string | undefined)) ===
			"delivered",
		known,
		beginAttempt: (id, now) =>
			one(
				"UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'pending' RETURNING attempts",
				now,
				id,
			)?.attempts as number | undefined,
		finish: (id, status, now) =>
			run("UPDATE outbox SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'", status, now, id)
				.changes === 1,
		retry: (id) =>
			tx(() => {
				const r = find(id);
				if (r?.status === "dead_letter")
					run(
						"UPDATE outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, finished_at = NULL WHERE id = ?",
						r.id,
					);
				return r?.status;
			}),
		cancel: (id, now) =>
			tx(() => {
				const r = find(id);
				if (r && (r.status === "pending" || r.status === "dead_letter"))
					run("UPDATE outbox SET status = 'cancelled', finished_at = ? WHERE id = ?", now, r.id);
				return r?.status;
			}),
		// Only a terminal row goes: a delivered or cancelled row that no unresolved claim still names. Its ids stay in wake_tombstones (migration 7), which is what stops them being enqueued again.
		prune: (before) =>
			run(
				`DELETE FROM outbox WHERE status IN ('delivered', 'cancelled') AND finished_at < ?
			 AND id NOT IN (SELECT m.outbox_id FROM outbox_members m JOIN claims c ON c.delivery_id = m.delivery_id JOIN items i ON i.id = c.item_id WHERE i.state != 'resolved')`,
				before,
			).changes,
	};

	// ---- confirmation challenges --------------------------------------------------------------------
	const challenges: Store["challenges"] = {
		issue(c: Challenge) {
			tx(() => {
				run(
					"DELETE FROM confirmation_challenges WHERE card_id = ? AND session_hash = ? AND consumed_at IS NULL",
					c.cardId,
					c.sessionHash,
				);
				run(
					"INSERT INTO confirmation_challenges (token_hash, card_id, sig, choice, session_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					c.tokenHash,
					c.cardId,
					c.sig,
					c.choice,
					c.sessionHash,
					c.issuedAt,
					c.expiresAt,
				);
			});
		},
		consume(tokenHash, expect, now): ChallengeVerdict {
			return tx(() => {
				const r = one("SELECT * FROM confirmation_challenges WHERE token_hash = ?", tokenHash);
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
				run(
					"UPDATE confirmation_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
					now,
					tokenHash,
				);
				return "ok";
			});
		},
		prune: (before) =>
			run(
				"DELETE FROM confirmation_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)",
				before,
				before,
			).changes,
	};

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
	const events: Store["events"] = {
		append(e, importKey) {
			const { t, event, src, ...data } = e;
			run(
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
			return all(
				`SELECT * FROM events ${w.sql} ORDER BY id ${q.limit ? `LIMIT ${Math.floor(q.limit)}` : ""}`,
				...w.p,
			).map(toEvent);
		},
		count: (q = {}) => {
			const w = eventWhere(q);
			return one(`SELECT COUNT(*) AS n FROM events ${w.sql}`, ...w.p)!.n as number;
		},
		prune: (before) => run("DELETE FROM events WHERE t < ?", before).changes,
	};

	// ---- the sequence (migration 12) -------------------------------------------------------------------
	const sequence: Store["sequence"] = {
		next: () =>
			tx(() => one("UPDATE store_sequence SET value = value + 1 WHERE id = 1 RETURNING value")!.value as number),
		current: () => one("SELECT value FROM store_sequence WHERE id = 1")!.value as number,
	};

	return {
		path,
		tx,
		close: () => db.close(),
		items,
		claims,
		evidence,
		rulings,
		decisions,
		butlers,
		away,
		wakes,
		challenges,
		events,
		state,
		sequence,
	};
}

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

function migrate(db: Database, path: string) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const newest = () => (db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0;
	const found = newest();
	if (found > LATEST_MIGRATION) throw new DatabaseTooNewError(path, found);
	for (const m of MIGRATIONS) {
		if (m.version <= found) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			// Another process may have applied it while this one waited for the lock.
			if (m.version > newest()) {
				db.exec(m.sql);
				db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
					m.version,
					m.name,
					new Date().toISOString(),
				);
			}
			db.exec("COMMIT");
		} catch (e) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ended */
			}
			throw e;
		}
	}
}

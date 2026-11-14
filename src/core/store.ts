/**
 * The Store: the one interface core logic uses for every piece of state Chamberlain keeps. Everything the daemon, the
 * page and the command-line tools used to keep in files (the queue, rulings, the one-wake claims, the outbox and held wakes, butlers, the away record, the fired sets, the event log) is behind it. Config files and the evidence
 * blobs stay on disk; the Store holds rows that point to the evidence files.
 *
 * `src/core/sqlite-store.ts` is the one implementation (bun:sqlite, one database file). Tests use the same
 * implementation on a temporary or in-memory database; there is no second, fake store to drift from the real one.
 *
 * Every method is synchronous. `tx` runs a function as one transaction and may be nested; whatever a function does
 * through the store inside `tx` commits together or not at all, across processes (the file is opened in WAL mode with a
 * busy timeout, and a transaction takes the write lock when it starts).
 */
import type { Butler } from "./butler.ts";
import type { Ruling } from "./rulings.ts";
import type { DispositionStore, UsageStore } from "./store-records.ts";
import type { ChallengeStore, WakeStore } from "./store-wakes.ts";

// ---- the one item system ------------------------------------------------------------------------

/**
 * The incident states of PagerDuty, which Chamberlain's items follow:
 *   triggered: seen and unresolved. Whether anyone was notified is the notification count, not a state of its own.
 *   acknowledged: someone or something learned of it and it stays quiet until it recurs (a seeded finding, a question set
 *     aside with "not now"). Notifications stop; a new observation does not restart them.
 *   resolved: gone, answered or delivered; kept for the record. A recurrence is a new occurrence (it triggers again).
 */
export type ItemStatus = "triggered" | "acknowledged" | "resolved";
/**
 * silenced: tracked, never notifies (an Alertmanager silence). shadow: runs the real decision and records what it would have
 * sent, in counters of its own, but notifies nobody (a shadow deployment). live: notifies for real.
 */
export type ItemMode = "silenced" | "shadow" | "live";
/** What an item is about: a pull request, a run, a deploy, a thread. (CloudEvents calls this the subject.) */
export type Subject = { kind: string; id: string };

/**
 * The re-notification policy an item's source asks for. After the n-th notification the next one is `intervalsMs[n - 1]`
 * later (the last interval repeats), for as long as the item persists and fewer than `maxNotifications` have gone out. No
 * intervals means one notification. (Alertmanager's `repeat_interval`, with a cap.)
 */
export type RepeatPolicy = { intervalsMs: readonly number[]; maxNotifications: number };

export type Item = {
	id: number;
	/** Who produces it: "check:disk", "queue", "notification-log", "alarm", "held". */
	source: string;
	/** What it is: "finding", "evaluation_error", "question", "alarm", "hold", "sent". */
	kind: string;
	/** Stable, and unique per source: PagerDuty's `dedup_key`. Observing the same key again is the same item. */
	dedupKey: string;
	status: ItemStatus;
	mode: ItemMode;
	firstSeen: number;
	lastSeen: number;
	resolvedAt: number | null;
	/** Live notifications sent. Never touched by a shadow-mode would-be notification. */
	notificationCount: number;
	nextNotificationAt: number | null;
	/** Shadow mode: notifications that would have gone out. Kept apart, so going live never counts one as sent. */
	shadowNotificationCount: number;
	shadowNextNotificationAt: number | null;
	subject: Subject | null;
	payload: Record<string, unknown>;
};

export type Observation = {
	source: string;
	kind: string;
	dedupKey: string;
	/** Default live. */
	mode?: ItemMode;
	subject?: Subject;
	/** Replaces the stored payload when given. */
	payload?: Record<string, unknown>;
	/** Default: one notification. */
	repeat?: RepeatPolicy;
	/** A new item is learned silently: it starts acknowledged and notifies nobody. */
	baseline?: boolean;
	now?: number;
};
export type Observed = { item: Item; created: boolean; reopened: boolean; notify: boolean; wouldNotify: boolean };
export type ItemFilter = { source?: string; kind?: string; status?: ItemStatus | ItemStatus[]; subject?: Subject };

interface ItemStore {
	/**
	 * Reports that an item exists now: creates it, refreshes `last_seen`, reopens a resolved one as a new occurrence, and
	 * asks the one notification function (`decideNotification` in notification.ts) whether it notifies. This is the only
	 * writer of the notification columns.
	 */
	observe(o: Observation): Observed;
	get(source: string, dedupKey: string): Item | undefined;
	list(f?: ItemFilter): Item[];
	/** Moves an item to resolved (idempotent), merging `patch` into its payload. Returns it, or undefined when there is none. */
	resolve(source: string, dedupKey: string, now?: number, patch?: Record<string, unknown>): Item | undefined;
	/** Moves a triggered item to acknowledged, merging `patch` into its payload. */
	acknowledge(source: string, dedupKey: string, now?: number, patch?: Record<string, unknown>): Item | undefined;
	/** Merges `patch` into an item's payload and changes nothing else. */
	patch(source: string, dedupKey: string, patch: Record<string, unknown>): Item | undefined;
	/** Resolves every unresolved item of a source (and kind) whose dedup key is not in `present`. Returns what it resolved. */
	resolveAbsent(source: string, kind: string, present: Iterable<string>, now?: number): Item[];
	/** Deletes resolved items last seen before `before`, and the rows hanging off them, except those of `keepSources` (default: the queue, whose answers are history). Returns how many. */
	prune(before: number, keepSources?: string[]): number;
}

// ---- the one-wake claims, direct relays, evidence -----------------------------------------------

/** A claim on an item's one wake, with everything needed to send it. `item` is the item's dedup key. */
export type ClaimRecord = {
	owner: string;
	item: string;
	deliveryId: string;
	message: string;
	t: string;
	answer?: unknown;
	ruling?: unknown;
	relay?: unknown;
};
export type RelayRecord = {
	started: boolean;
	outcome?: "delivered" | "failed";
	detail?: string /** When it finished. */;
	t?: string;
};
export type EvidenceRow = { type: "image" | "video" | "link"; name?: string; url?: string; caption?: string };

interface ClaimStore {
	/**
	 * Takes an item's one wake: inserts the claim in one transaction. The first claim wins,
	 * enforced by a unique constraint, across processes; every later claimant gets the winner's claim back.
	 */
	claim(source: string, c: ClaimRecord): { won: boolean; claim: ClaimRecord };
	get(source: string, item: string): ClaimRecord | undefined;
	list(source: string): ClaimRecord[];
	/** Gives an item's claim up, so it can be claimed again (an answer that was never sent). The item stays. */
	release(source: string, item: string): void;
	/** The one direct send of a thread-routed answer. `start` is true only for the first caller, ever. */
	startRelay(source: string, item: string, t?: string): boolean;
	finishRelay(
		source: string,
		item: string,
		result: { outcome: "delivered" | "failed"; detail?: string; t?: string },
	): void;
	readRelay(source: string, item: string): RelayRecord;
	/** Every finished-or-started direct send of a source, by item key. */
	listRelays(source: string): Map<string, RelayRecord>;
}

interface EvidenceStore {
	put(source: string, item: string, rows: EvidenceRow[]): void;
	list(source: string, item: string): EvidenceRow[];
	/** Every item's evidence rows, by item key. */
	listAll(source: string): Map<string, EvidenceRow[]>;
}

// ---- rulings, decisions, butlers, the away record -----------------------------------------------

interface RulingStore {
	list(): Ruling[];
	/** Inserts or replaces one ruling by id. */
	save(r: Ruling): void;
}
export type DecisionRow = {
	t: string;
	thread: string;
	decision: string;
	ruling: string;
	rulingIds?: string[];
	ref: string | null;
};
interface DecisionStore {
	/** Returns the new row's id (the ledger key of its event: `decision:<id>`). */
	append(d: DecisionRow): number;
	list(): DecisionRow[];
}
interface ButlerStore {
	list(): Butler[];
	get(id: string): Butler | undefined;
	/** False when the id is already in the ledger. */
	insert(b: Omit<Butler, "stopped" | "reason">): boolean;
	/** False when it is unknown or already stopped. */
	stop(id: string, stopped: string, reason?: string): boolean;
}
export type AwayRecord = { enteredAt: string; words: string; expectedReturn?: string; spendNote?: string };
interface AwayStore {
	current(): AwayRecord | undefined;
	/** Starts an absence, replacing a current one. */
	enter(a: AwayRecord): void;
	/** Ends the current absence. Returns it. */
	exit(at: string): AwayRecord | undefined;
}

// ---- the event log and small state --------------------------------------------------------------

/** One line of the daemon's log: `t` and `event` and, when set, `src`, then whatever fields the event carried. */
export type LogEvent = { t: string; event: string; src?: string } & Record<string, unknown>;
export type EventQuery = { since?: string; until?: string; events?: string[]; src?: string; limit?: number };
interface EventStore {
	append(e: LogEvent, importKey?: string): void;
	/** Appends every line in one transaction, never waiting for another process's write lock: false when the database is busy (nothing is written), so the caller can try again. */
	tryAppendMany(lines: readonly (readonly [LogEvent, string | undefined])[]): boolean;
	/** Oldest first. */
	query(q?: EventQuery): LogEvent[];
	count(q?: EventQuery): number;
	prune(before: string): number;
}

interface StateStore {
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): void;
	/** A read-modify-write in one transaction. Returning undefined deletes the key. */
	update<T>(key: string, fn: (prior: T | undefined) => T | undefined): T | undefined;
}

/**
 * One durable, monotonic counter (migration 12). `next` raises it by one in a transaction and returns the new value, which is
 * greater than every value any process took before it. It orders events without the wall clock: a card hold records a value
 * when it is written, and a read taken with a greater value started after that hold was committed.
 */
interface SequenceStore {
	next(): number;
	/** The newest value taken (0 before any). */
	current(): number;
}

export interface Store {
	/** The database file, or ":memory:". */
	readonly path: string;
	/** Runs `fn` as one transaction (BEGIN IMMEDIATE), or as a savepoint inside one. It must not await. */
	tx<T>(fn: () => T): T;
	close(): void;
	/** Runs `fn` once the outermost open transaction has committed, at once when none is open, and never when it rolls back. It must not throw. */
	afterCommit(fn: () => void): void;
	/** Runs `fn` when the store closes (the telemetry database opened for this store, src/core/log.ts, closes with it). */
	onClose(fn: () => void): void;
	readonly items: ItemStore;
	readonly claims: ClaimStore;
	readonly evidence: EvidenceStore;
	readonly rulings: RulingStore;
	readonly decisions: DecisionStore;
	readonly butlers: ButlerStore;
	readonly away: AwayStore;
	readonly wakes: WakeStore;
	readonly challenges: ChallengeStore;
	readonly events: EventStore;
	readonly state: StateStore;
	readonly sequence: SequenceStore;
	readonly usage: UsageStore;
	readonly dispositions: DispositionStore;
}

/** The database file's name in the state directory. */
export const DB_FILE = "chamberlain.db";
export const dbPath = (state: string) => `${state}/${DB_FILE}`;

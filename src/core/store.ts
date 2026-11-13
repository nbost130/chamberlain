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

export interface ItemStore {
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
export type ClaimRecord = { owner: string; item: string; deliveryId: string; message: string; t: string; answer?: unknown; ruling?: unknown; relay?: unknown };
export type RelayRecord = { started: boolean; outcome?: "delivered" | "failed"; detail?: string; /** When it finished. */ t?: string };
export type EvidenceRow = { type: "image" | "video" | "link"; name?: string; url?: string; caption?: string };

export interface ClaimStore {
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
	finishRelay(source: string, item: string, outcome: "delivered" | "failed", detail?: string, t?: string): void;
	readRelay(source: string, item: string): RelayRecord;
	/** Every finished-or-started direct send of a source, by item key. */
	listRelays(source: string): Map<string, RelayRecord>;
}

export interface EvidenceStore {
	put(source: string, item: string, rows: EvidenceRow[]): void;
	list(source: string, item: string): EvidenceRow[];
	/** Every item's evidence rows, by item key. */
	listAll(source: string): Map<string, EvidenceRow[]>;
}

// ---- rulings, decisions, butlers, the away record -----------------------------------------------

export interface RulingStore {
	list(): Ruling[];
	/** Inserts or replaces one ruling by id. */
	save(r: Ruling): void;
}
export type DecisionRow = { t: string; thread: string; decision: string; ruling: string; rulingIds?: string[]; ref: string | null };
export interface DecisionStore {
	append(d: DecisionRow): void;
	list(): DecisionRow[];
}
export interface ButlerStore {
	list(): Butler[];
	get(id: string): Butler | undefined;
	/** False when the id is already in the ledger. */
	insert(b: Omit<Butler, "stopped" | "reason">): boolean;
	/** False when it is unknown or already stopped. */
	stop(id: string, stopped: string, reason?: string): boolean;
}
export type AwayRecord = { enteredAt: string; words: string; expectedReturn?: string; spendNote?: string };
export interface AwayStore {
	current(): AwayRecord | undefined;
	/** Starts an absence, replacing a current one. */
	enter(a: AwayRecord): void;
	/** Ends the current absence. Returns it. */
	exit(at: string): AwayRecord | undefined;
}

// ---- wakes: the transactional outbox, held items ----------------------------------------------------

/** What a wake is about, so a repeat can be told from a new event. A wake about no thread (a sweep) has a kind alone. */
/**
 * What a wake carrying the "rights unchanged" pointer was composed for: the Steward's thread and session, the rights hash (rights-sent.ts)
 * and when the full text last went out (the pointer names it). The relay checks it just before each POST (`RelayDeps.rightsFirst`).
 */
export type RightsStamp = {
	steward?: string; session?: string; hash: string; at?: string;
	/**
	 * "unstamped": a Steward wake queued before the stamps existed (migration 10 marks every undelivered Steward row and held wake that has no
	 * stamp, whatever its text; legacy-import.ts marks every wake it brings in). Which Steward it was composed for is unknown, so it never
	 * holds: the relay always sends the full rights ahead of it.
	 */
	legacy?: "unstamped";
};
export type WakeMeta = {
	kind: string; thread?: string; /** Who the wake is for: absent is the Steward, "desk" is the Alert Desk's own thread. Alertmanager's `receiver`. */ receiver?: string;
	/** One stamp per rights pointer the wake carries (a digest can carry several); absent when it carries none. */
	rights?: RightsStamp[];
};
/** Which receiver's wakes a read is about: `null` is the Steward's, a name is that receiver's, and `undefined` is every receiver's. */
export type Lane = string | null | undefined;
/** A wake as a producer hands it in: its one delivery id, its text, when it was made and what it is about. */
export type WakeRow = { deliveryId: string; message: string; queuedAt: number } & Partial<WakeMeta>;
/** A holdable wake waiting for the Steward to go idle. Not yet bound to any outbox row. */
export type HeldItem = WakeRow;
/** The relay's look at the Steward: how long it has been busy, and when the last post and the last ceiling digest went. Kept in the relay's memory. */
export type HoldClock = { busySince?: number; seenAt?: number; lastPostAt?: number; lastForcedAt?: number };

/**
 * pending: the relay sends it. delivered: the transport accepted it (terminal). dead_letter: it used every attempt without a delivered record,
 * and waits for the operator's retry or cancel. cancelled: given up by the operator, kept as a tombstone (terminal).
 */
export type OutboxStatus = "pending" | "delivered" | "dead_letter" | "cancelled";
/** One outbox row. Everything but status, attempts and the two times is frozen when the row is created (a database trigger refuses a change). */
export type OutboxRow = {
	id: number; deliveryId: string; message: string; kind?: string; thread?: string; receiver?: string; createdAt: number;
	/** The rights stamps it was composed with (`WakeMeta.rights`): checked just before each POST. */
	rights?: RightsStamp[];
	/** For a digest: how many held wakes were folded into a later one about the same thread and kind. */
	folded: number;
	status: OutboxStatus; attempts: number; lastAttemptAt?: number; finishedAt?: number;
	/** Every delivery id this row carries: its own, or a digest's members (folded ones included). Each belongs to this row only, ever. */
	members: HeldItem[];
};
/** A digest (or a lone held wake) as composed, ready to be frozen into a row with the held items it carries. */
export type Composed = { deliveryId: string; message: string; folded: number; members: string[] } & Partial<WakeMeta>;

export interface WakeStore {
	/**
	 * A producer's wake for now: inserts a pending outbox row, with its own id bound as its one member, in the caller's transaction. False
	 * (nothing written) when the id is already known: bound to any row, whatever its status (so a delivered or cancelled wake is never
	 * enqueued again), or held.
	 */
	enqueue(w: WakeRow): boolean;
	/** A producer's holdable wake: held until the relay composes it into a row. False (nothing written) when the id is already known. */
	hold(w: HeldItem): boolean;
	/** Every held item, oldest first. `lane` picks one receiver's (`null`: the Steward's); without it, all of them. */
	held(lane?: Lane): HeldItem[];
	/**
	 * The relay's composition, ONE transaction: `compose` picks the row from the items held now; the row is inserted with its members bound
	 * (a member already bound to another row is refused by the primary key, and the whole composition with it) and they leave the held store.
	 * Undefined when nothing is held.
	 */
	compose(now: number, compose: (held: HeldItem[]) => Composed, lane?: Lane): OutboxRow | undefined;
	/** Rows by status (default pending), oldest first. `lane` picks one receiver's rows; without it, all of them. */
	rows(status?: OutboxStatus | "all", lane?: Lane): OutboxRow[];
	/** The row an id belongs to: as its own delivery id or as a member. */
	find(deliveryId: string): OutboxRow | undefined;
	/** Is this id bound to a delivered row? */
	isDelivered(deliveryId: string): boolean;
	/** Is this id held or bound to a row of any status? */
	known(deliveryId: string): boolean;
	/** The relay, before each POST: attempts + 1 and the attempt's time, on a pending row. Returns the new count, or undefined when the row is not pending. */
	beginAttempt(id: number, now: number): number | undefined;
	/** Moves a pending row to delivered or dead_letter. False when it was not pending (an operator cancelled it meanwhile). */
	finish(id: number, status: "delivered" | "dead_letter", now: number): boolean;
	/** The operator's retry: a dead_letter row only, back to pending with attempts at 0. What it found, or undefined when no row has the id. */
	retry(deliveryId: string): OutboxStatus | undefined;
	/** The operator's cancel: a pending or dead_letter row becomes a cancelled tombstone, members and all. What it found, or undefined. */
	cancel(deliveryId: string, now: number): OutboxStatus | undefined;
	/** Deletes delivered and cancelled rows finished before `before`, except those an unresolved claim still names. Nothing else is ever deleted. */
	prune(before: number): number;
}

// ---- confirmation challenges --------------------------------------------------------------------

/** A single-use, expiring confirmation for one approval, bound to its card fingerprint, the chosen decision and the session. Only the token's hash is kept. */
export type Challenge = { tokenHash: string; cardId: string; sig: string; choice: number; sessionHash: string; issuedAt: number; expiresAt: number };
export type ChallengeVerdict = "ok" | "unknown" | "expired" | "used" | "mismatch";
export interface ChallengeStore {
	/** Records a new challenge, and deletes this session's earlier unconsumed ones for the same card (one live challenge per card and session). */
	issue(c: Challenge): void;
	/**
	 * Consumes a challenge in one transaction: "ok" only when it exists, is unused, has not expired, and was issued for exactly this card
	 * fingerprint, choice and session; the row is then marked consumed, so a second presentation is "used". A refusal changes nothing.
	 */
	consume(tokenHash: string, expect: { cardId: string; sig: string; choice: number; sessionHash: string }, now: number): ChallengeVerdict;
	/** Deletes challenges that expired, or were consumed, before `before` (terminal rows only). */
	prune(before: number): number;
}

// ---- the event log and small state --------------------------------------------------------------

/** One line of the daemon's log: `t` and `event` and, when set, `src`, then whatever fields the event carried. */
export type LogEvent = { t: string; event: string; src?: string } & Record<string, unknown>;
export type EventQuery = { since?: string; until?: string; events?: string[]; src?: string; limit?: number };
export interface EventStore {
	append(e: LogEvent, importKey?: string): void;
	/** Oldest first. */
	query(q?: EventQuery): LogEvent[];
	count(q?: EventQuery): number;
	prune(before: string): number;
}

export interface StateStore {
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): void;
	/** A read-modify-write in one transaction. Returning undefined deletes the key. */
	update<T>(key: string, fn: (prior: T | undefined) => T | undefined): T | undefined;
}

export interface Store {
	/** The database file, or ":memory:". */
	readonly path: string;
	/** Runs `fn` as one transaction (BEGIN IMMEDIATE), or as a savepoint inside one. It must not await. */
	tx<T>(fn: () => T): T;
	close(): void;
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
}

/** The database file's name in the state directory. */
export const DB_FILE = "chamberlain.db";
export const dbPath = (state: string) => `${state}/${DB_FILE}`;

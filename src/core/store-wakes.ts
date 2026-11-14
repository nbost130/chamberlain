/** The wake outbox and confirmation challenges: the types and the stores a wake and a challenge are kept in. */

// ---- wakes: the transactional outbox, held items ----------------------------------------------------

/** What a wake is about, so a repeat can be told from a new event. A wake about no thread (a sweep) has a kind alone. */
/**
 * What a wake's rights text was composed for: the Steward's thread and session, the rights hash (rights-sent.ts) and when the full text last
 * went out (a pointer names it). A pointer or legacy stamp makes the row depend on the Steward already holding the rights: before every attempt
 * the relay sends a full-rights prerequisite ahead of it unless the durable rights record shows the Steward there now holds the rights in
 * force now. A `full` stamp is on a wake that carries the whole block: when that row is delivered, the relay writes the rights record from it
 * in the same transaction.
 */
export type RightsStamp = {
	steward?: string;
	session?: string;
	hash: string;
	at?: string;
	/** The wake carries the full block, composed for this state; `used` is the Steward's context size then (the record's high-water mark). */
	full?: true;
	used?: number;
	/** The rights epoch the wake was composed under (rights-sent.ts): a delivered full stamp writes the record only while it is still current. Absent is 0. */
	epoch?: number;
	/**
	 * "unstamped": a Steward wake queued before the stamps existed (migration 10 marks every undelivered Steward row and held wake that has no
	 * stamp, whatever its text). Which Steward it was composed for is unknown, so it depends
	 * on the record like a pointer does.
	 */
	legacy?: "unstamped";
};
export type WakeMeta = {
	kind: string;
	thread?: string /** Who the wake is for: absent is the Steward, "desk" is the Alert Desk's own thread. Alertmanager's `receiver`. */;
	receiver?: string;
	/** One stamp per rights text the wake carries, a pointer or the full block (a digest can carry several); absent when it carries none. */
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
	id: number;
	deliveryId: string;
	message: string;
	kind?: string;
	thread?: string;
	receiver?: string;
	createdAt: number;
	/** The rights stamps it was composed with (`WakeMeta.rights`): checked just before each attempt, and a full one is recorded at delivery. */
	rights?: RightsStamp[];
	/** For a digest: how many held wakes were folded into a later one about the same thread and kind. */
	folded: number;
	status: OutboxStatus;
	attempts: number;
	lastAttemptAt?: number;
	finishedAt?: number;
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
export type Challenge = {
	tokenHash: string;
	cardId: string;
	sig: string;
	choice: number;
	sessionHash: string;
	issuedAt: number;
	expiresAt: number;
};
export type ChallengeVerdict = "ok" | "unknown" | "expired" | "used" | "mismatch";
export interface ChallengeStore {
	/** Records a new challenge, and deletes this session's earlier unconsumed ones for the same card (one live challenge per card and session). */
	issue(c: Challenge): void;
	/**
	 * Consumes a challenge in one transaction: "ok" only when it exists, is unused, has not expired, and was issued for exactly this card
	 * fingerprint, choice and session; the row is then marked consumed, so a second presentation is "used". A refusal changes nothing.
	 */
	consume(
		tokenHash: string,
		expect: { cardId: string; sig: string; choice: number; sessionHash: string },
		now: number,
	): ChallengeVerdict;
	/** Deletes challenges that expired, or were consumed, before `before` (terminal rows only). */
	prune(before: number): number;
}

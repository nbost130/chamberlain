/**
 * What the daemon last sent the Steward of its decision rights, kept in the database (state key `rights-sent`) so a restart
 * does not forget it and re-send the full set to a Steward that already holds it. No record, or one that cannot be
 * trusted, means the next wake sends them in full: doubt always sends them again.
 */
import { createHash } from "node:crypto";
import { RIGHTS_MARKER, rightsInFull, rightsUnchanged, type RightsSent } from "./decide.ts";
import type { RightsStamp, Store } from "./store.ts";

export const RIGHTS_SENT_KEY = "rights-sent";

/** Pure: the record a stored value holds, or undefined when it is anything but a well-formed record. */
export function parseRightsSent(raw: unknown): RightsSent | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { hash, used, at, steward, session, epoch } = raw as Record<string, unknown>;
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
	if (epoch !== undefined && !isEpoch(epoch)) return undefined;
	if (at !== undefined && typeof at !== "string") return undefined;
	if (steward !== undefined && typeof steward !== "string") return undefined;
	if (session !== undefined && typeof session !== "string") return undefined;
	if (used !== undefined && (typeof used !== "number" || !Number.isFinite(used) || used < 0)) return undefined;
	return { hash, ...(used !== undefined ? { used } : {}), ...(at ? { at } : {}), ...(steward ? { steward } : {}), ...(session ? { session } : {}), ...(epoch !== undefined ? { epoch: epoch as number } : {}) };
}

const isEpoch = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The rights epoch: an integer kept in the same state row as the record (`{ epoch }` alone when no record holds). A compaction (relay.ts,
 * `compact`, inside the serial job, before its POST) or a context shrink (the engine's minute check) bumps it and drops the record in one
 * write (`invalidateRights`). Every full stamp records the epoch it was composed under, and the relay writes the record from a delivered full
 * stamp only when that epoch is still the current one, so a full wake composed before a compaction can never restore the record after it.
 * No row, or a row with no epoch, is epoch 0. The row is never deleted, only replaced, so the epoch only rises.
 */
export function rightsEpoch(store: Store): number {
	const raw = store.state.get<Record<string, unknown>>(RIGHTS_SENT_KEY);
	return raw && typeof raw === "object" && isEpoch(raw.epoch) ? raw.epoch : 0;
}

/** Pure: the epoch a record or stamp was written under (absent is 0, the epoch before the first bump). */
export const epochOf = (x: { epoch?: number } | undefined) => x?.epoch ?? 0;

/** Bumps the epoch and drops the record, in one transaction. Returns the new epoch. Throws when the write fails. */
export function invalidateRights(store: Store): number {
	return store.tx(() => { const next = rightsEpoch(store) + 1; store.state.set(RIGHTS_SENT_KEY, { epoch: next }); return next; });
}

/** The record in the database, or undefined (so the next wake sends in full) when there is none or it can't be trusted. */
export function loadRightsSent(store: Store): RightsSent | undefined {
	try { return parseRightsSent(store.state.get(RIGHTS_SENT_KEY)); } catch { return undefined; }
}

/**
 * Replace the record, or invalidate it for undefined (the epoch rises; the row is never deleted). A record is kept only under the epoch it
 * names: one written for an older epoch is not stored.
 */
export function saveRightsSent(sent: RightsSent | undefined, store: Store) {
	if (!sent) { invalidateRights(store); return; }
	store.tx(() => { if (epochOf(sent) === rightsEpoch(store)) store.state.set(RIGHTS_SENT_KEY, sent); });
}

/**
 * The daemon's handle on the record. It is never cached: the relay writes it in the transaction that marks a full-rights wake delivered
 * (relay.ts, `land`), so every read goes to the database. A failed write is reported through onError and never costs a wake; a failed
 * read is no record, so the next wake sends the rights in full.
 */
export function openRightsSent(store: Store, onError: (e: unknown) => void = () => {}) {
	return {
		get: () => loadRightsSent(store),
		set(next: RightsSent | undefined) { try { saveRightsSent(next, store); } catch (e) { onError(e); } },
		/** The current epoch, read from the database. */
		epoch: () => { try { return rightsEpoch(store); } catch (e) { onError(e); return 0; } },
	};
}

/** Pure: the record after the minute's size check. A shrink (a compaction) drops it; otherwise the high-water mark rises. */
export function rightsHighWater(sent: RightsSent | undefined, used: number | undefined): RightsSent | undefined {
	if (!sent) return undefined;
	return rightsInFull(sent, sent.hash, used) ? undefined : { ...sent, used };
}

/** Pure: what this wake records as sent: the Steward thread and its rights and rulings. The away mandate rides every wake, so it is not part of the hash: toggling away mode never re-sends the block. */
export const rightsHash = (stewardId: string | undefined, rules: string) =>
	createHash("sha256").update([stewardId, rules].join("\n")).digest("hex");

/**
 * Pure: the rights text a wake carries, the record to keep if it is delivered, and whether it is the full block. `at` is when the full text
 * last went out. A wake that carries the pointer instead (`full` false) is stamped with what it was composed for (`rightsStamp`), so the
 * relay can tell, just before it sends it, whether the Steward it reaches still holds them.
 */
export function rightsFor(sent: RightsSent | undefined, stewardId: string | undefined, rules: string, mandate: string, used: number | undefined, now = new Date().toISOString(), epoch?: number): { text: string; record: RightsSent; full: boolean } {
	const hash = rightsHash(stewardId, rules), full = rightsInFull(sent, hash, used);
	const body = full ? `${RIGHTS_MARKER}\n${rules}` : rightsUnchanged(sent?.at);
	return { text: [body, mandate].filter(Boolean).join("\n"), record: { hash, used, at: full ? now : sent?.at, ...(epoch !== undefined ? { epoch } : {}) }, full };
}

/** Pure: the stamp a pointer wake carries: the Steward thread and session it was composed for, the rights hash, and the `at` its pointer line names. */
export const rightsStamp = (record: RightsSent, stewardId: string | undefined, session: string | undefined): RightsStamp =>
	({ ...(stewardId ? { steward: stewardId } : {}), ...(session ? { session } : {}), hash: record.hash, ...(record.at ? { at: record.at } : {}), ...(record.epoch !== undefined ? { epoch: record.epoch } : {}) });

/**
 * Pure: the stamp a wake carrying the FULL block has (`full`): the Steward thread and session it was composed for, the rights hash, when it
 * was composed and the Steward's context size then. When the row is delivered the relay writes the rights record from it, in the same
 * transaction (`recordOf`): that record is the durable proof of which Steward holds which rights.
 */
export const fullStamp = (record: RightsSent, stewardId: string | undefined, session: string | undefined): RightsStamp =>
	({ ...rightsStamp(record, stewardId, session), ...(record.used !== undefined ? { used: record.used } : {}), full: true });

/** Pure: the rights record a delivered full stamp proves (under the epoch the stamp was composed in: `land` writes it only if that is still current). */
export const recordOf = (st: RightsStamp): RightsSent =>
	({ hash: st.hash, ...(st.used !== undefined ? { used: st.used } : {}), ...(st.at ? { at: st.at } : {}), ...(st.steward ? { steward: st.steward } : {}), ...(st.session ? { session: st.session } : {}), ...(st.epoch !== undefined ? { epoch: st.epoch } : {}) });

/** Pure: does a row depend on the Steward already holding the rights? It does when it carries any stamp that is not a full block: a pointer, or a legacy stamp. */
export const needsRights = (stamps: readonly RightsStamp[] | undefined) => Boolean(stamps?.some((s) => !s.full));

/** The Steward and the rights now: the state a rights prerequisite is keyed by. `hash` is absent when the rights cannot be read; `epoch` absent is 0. */
export type RightsState = { steward?: string; session?: string; hash?: string; epoch?: number };

/**
 * Pure: why the durable record does not show that the Steward there now holds the rights in force now, or undefined when it does. It shows it
 * only for a record with the same Steward thread, the same session, the same rights hash and the same epoch. Anything else, doubt included, is a gap.
 */
export function rightsGap(record: RightsSent | undefined, now: RightsState): string | undefined {
	if (now.hash === undefined) return "the decision rights cannot be read now";
	if (!record) return "no full-rights wake is recorded as delivered (none yet, a compaction, or an upgrade)";
	if (record.steward !== now.steward) return `the Steward thread changed (${record.steward ?? "none recorded"} to ${now.steward ?? "none"}) since the rights were last delivered`;
	if (record.session !== now.session) return `the Steward session changed (${record.session ?? "none recorded"} to ${now.session ?? "unknown"}) since the rights were last delivered`;
	if (record.hash !== now.hash) return "the rights or rulings changed since they were last delivered";
	if (epochOf(record) !== epochOf(now)) return `a compaction or context shrink since the rights were last delivered (epoch ${epochOf(record)} to ${epochOf(now)})`;
	return undefined;
}

/** The stamp of a Steward wake queued before the stamps existed (migration 10, and every wake legacy-import.ts brings in): its text is never read. */
export const LEGACY_STAMP: RightsStamp = { hash: "", legacy: "unstamped" };

/** Pure: a short key for one state (the Steward thread, its session, the rights hash or "unreadable", and the epoch when it is not 0). */
export const rightsStateKey = (now: RightsState) =>
	createHash("sha256").update([now.steward ?? "", now.session ?? "", now.hash ?? "unreadable", ...(epochOf(now) ? [String(epochOf(now))] : [])].join("\n")).digest("hex").slice(0, 16);

/**
 * The delivery id of the standalone full-rights wake (the prerequisite) the relay sends ahead of the row `deliveryId` names, for one state
 * (`rightsStateKey`). The outbox refuses a known id, so it is queued once per row and state; `n` > 1 only when the one before it for the
 * same state ended without the record showing it (it was cancelled, or a compaction cleared the record after it was delivered).
 */
export const rightsFirstId = (deliveryId: string, key: string, n = 1) => `${deliveryId}:rights-first:${key}${n > 1 ? `:${n}` : ""}`;
/** Pure: the state key a prerequisite's id names, or undefined when the id is not a prerequisite's. */
export const rightsFirstKey = (deliveryId: string) => /:rights-first:([0-9a-f]{16})(?::\d+)?$/.exec(deliveryId)?.[1];

/**
 * Pure: the standalone wake that goes ahead of a row that depends on rights the record does not show the Steward holds. It carries the full
 * block (`full`: the block, or the unreadable notice) and names the row that follows; that row is then sent exactly as it was queued.
 */
export const rightsFirstMessage = (forId: string, full: string) =>
	`[chamberlain] rights: your decision rights and the rulings in force, in full. The next wake (${forId}) was queued for a Steward that may not hold them; where it says they are unchanged, these are the ones it means, and they replace any older copy it carries.\n${full}`;

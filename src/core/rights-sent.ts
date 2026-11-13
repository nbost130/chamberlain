/**
 * What the daemon last sent the Steward of its decision rights, kept in the database (state key `rights-sent`) so a restart
 * does not forget it and re-send the full set to a Steward that already holds it. No record, or one that cannot be
 * trusted, means the next wake sends them in full: doubt always sends them again.
 */
import { createHash } from "node:crypto";
import { RIGHTS_MARKER, rightsInFull, rightsUnchanged, type RightsSent } from "./decide.ts";
import { RIGHTS_SEE_ABOVE } from "./hold.ts";
import type { RightsStamp, Store } from "./store.ts";

export const RIGHTS_SENT_KEY = "rights-sent";

/** Pure: the record a stored value holds, or undefined when it is anything but a well-formed record. */
export function parseRightsSent(raw: unknown): RightsSent | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { hash, used, at } = raw as Record<string, unknown>;
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
	if (at !== undefined && typeof at !== "string") return undefined;
	if (used === undefined) return { hash, ...(at ? { at } : {}) };
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
	return { hash, used, ...(at ? { at } : {}) };
}

/** The record in the database, or undefined (so the next wake sends in full) when there is none or it can't be trusted. */
export function loadRightsSent(store: Store): RightsSent | undefined {
	try { return parseRightsSent(store.state.get(RIGHTS_SENT_KEY)); } catch { return undefined; }
}

/** Replace the record, or remove it for undefined. */
export function saveRightsSent(sent: RightsSent | undefined, store: Store) {
	if (sent) store.state.set(RIGHTS_SENT_KEY, sent); else store.state.delete(RIGHTS_SENT_KEY);
}

const same = (a: RightsSent | undefined, b: RightsSent | undefined) => a?.hash === b?.hash && a?.used === b?.used && a?.at === b?.at;

/**
 * The daemon's one copy of the record: read once at startup, written through on every change. A failed write is reported
 * through onError and never costs a wake; the in-memory copy stays right for this process.
 */
export function openRightsSent(store: Store, onError: (e: unknown) => void = () => {}) {
	let sent = loadRightsSent(store);
	/** The database does not yet match memory. The daemon calls set every minute, so the save is retried until it holds. */
	let unsaved = false;
	return {
		get: () => sent,
		set(next: RightsSent | undefined) {
			if (same(sent, next) && !unsaved) return;
			sent = next;
			try { saveRightsSent(next, store); unsaved = false; } catch (e) { unsaved = true; onError(e); }
		},
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
export function rightsFor(sent: RightsSent | undefined, stewardId: string | undefined, rules: string, mandate: string, used: number | undefined, now = new Date().toISOString()): { text: string; record: RightsSent; full: boolean } {
	const hash = rightsHash(stewardId, rules), full = rightsInFull(sent, hash, used);
	const body = full ? `${RIGHTS_MARKER}\n${rules}` : rightsUnchanged(sent?.at);
	return { text: [body, mandate].filter(Boolean).join("\n"), record: { hash, used, at: full ? now : sent?.at }, full };
}

/** Pure: the stamp a pointer wake carries: the Steward thread and session it was composed for, the rights hash, and the `at` its pointer line names. */
export const rightsStamp = (record: RightsSent, stewardId: string | undefined, session: string | undefined): RightsStamp =>
	({ ...(stewardId ? { steward: stewardId } : {}), ...(session ? { session } : {}), hash: record.hash, ...(record.at ? { at: record.at } : {}) });

/**
 * Pure: why a queued pointer no longer holds for the Steward it is about to reach, or undefined when it still does. It holds only for the same
 * Steward thread and session, a rights record (what the Steward was last delivered) with the same hash, and, when the rights can be read now,
 * the same rights and rulings. Anything else, doubt included, means the Steward may not hold them.
 */
export function staleRights(stamps: readonly RightsStamp[], now: { steward: string | undefined; session: string | undefined; record: RightsSent | undefined; rules: string | undefined }): string | undefined {
	for (const st of stamps) {
		if (st.steward !== now.steward) return `the Steward thread changed (${st.steward ?? "none"} to ${now.steward ?? "none"}) since the rights pointer was queued`;
		if (st.session !== now.session) return `the Steward session changed (${st.session ?? "unknown"} to ${now.session ?? "unknown"}) since the rights pointer was queued`;
		if (now.record?.hash !== st.hash) return "the rights record no longer matches the pointer (a compaction, or a full block that was never delivered): the Steward may not hold them";
		if (now.rules !== undefined && rightsHash(now.steward, now.rules) !== st.hash) return "the rights or rulings changed since the rights pointer was queued";
	}
	return undefined;
}

/**
 * Pure: a superseded wake's text with its rights pointers replaced: the first by `full` (the full block, or the unreadable notice), any later
 * one (a digest) by a line pointing at it. A message in which no pointer line is found gets `full` at its end.
 */
export function withFullRights(message: string, stamps: readonly RightsStamp[], full: string): string {
	let out = message, first = true;
	for (const line of new Set(stamps.map((st) => rightsUnchanged(st.at)))) {
		while (out.includes(line)) { const put = first ? full : RIGHTS_SEE_ABOVE; out = out.replace(line, () => put); first = false; }
	}
	return first ? `${out}\n${full}` : out;
}

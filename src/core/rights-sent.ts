/**
 * What the daemon last sent the Steward of its decision rights, kept in the database (state key `rights-sent`) so a restart
 * does not forget it and re-send the full set to a Steward that already holds it. No record, or one that cannot be
 * trusted, means the next wake sends them in full: doubt always sends them again.
 */
import { createHash } from "node:crypto";
import { RIGHTS_MARKER, rightsInFull, rightsUnchanged, type RightsSent } from "./decide.ts";
import type { Store } from "./store.ts";

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

/** Pure: the rights text a wake carries, and the record to keep if it is delivered. `at` is when the full text last went out. */
export function rightsFor(sent: RightsSent | undefined, stewardId: string | undefined, rules: string, mandate: string, used: number | undefined, now = new Date().toISOString()): { text: string; record: RightsSent } {
	const hash = rightsHash(stewardId, rules), full = rightsInFull(sent, hash, used);
	const body = full ? `${RIGHTS_MARKER}\n${rules}` : rightsUnchanged(sent?.at);
	return { text: [body, mandate].filter(Boolean).join("\n"), record: { hash, used, at: full ? now : sent?.at } };
}

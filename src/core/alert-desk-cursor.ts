/** The inbox cursor: where the last pass stopped, rotating a big inbox away, and the retired files. */
import { existsSync, readdirSync, renameSync, type Stats, statSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DeskConfig, DeskEvent } from "./alert-desk-config.ts";
import { parseLine } from "./alert-desk-events.ts";
import { readLines } from "./alert-desk-read.ts";

export type Retired = { path: string; offset: number; after: number };
export type Cursor = {
	offset: number;
	inode: number;
	/** Inbox files already renamed away, read once more after `after` in case a writer still held the old file. A file leaves this list only in a saved cursor, and is deleted after that. */
	retired: Retired[];
	/** Saved BEFORE the inbox is renamed, so a crash at any step of a rotation can be finished: `from` is how far the cursor had read. */
	rotating?: { path: string; from: number; inode: number };
};
export const CURSOR_KEY = "alert-desk-inbox";
const freshCursor = (): Cursor => ({ offset: 0, inode: 0, retired: [] });
/**
 * The cursor of a desk with none stored. "end": the inbox's current end, so nothing already in it wakes the desk (a line still being written
 * at that moment is skipped whole, as the reader skips any line it starts inside). No inbox yet, or "beginning": its start.
 */
export function firstCursor(inbox: string, startAt: DeskConfig["startAt"]): Cursor {
	if (startAt === "beginning") return freshCursor();
	try {
		const st = statSync(inbox);
		return { offset: st.size, inode: st.ino, retired: [] };
	} catch {
		return freshCursor();
	}
}

export type Read = {
	events: DeskEvent[];
	bad: number;
	stale: number /** Retired files read in full by this call. They leave the cursor, and are deleted, only after the cursor without them is saved. */;
	retiredRead: Retired[];
};
/** The points of a pass a test can stop at, to prove a crash there loses nothing. */
export type CrashPoint =
	| "rotation-intent"
	| "renamed"
	| "rotation-saved"
	| "delivered"
	| "retired-read"
	| "retired-saved";

/**
 * Finishes a rotation a crash interrupted. The intent was saved before the rename, so: if the retired file exists the rename happened and the
 * cursor restarts at the new inbox; if it does not, nothing was renamed and the intent is dropped. Either way nothing unread is lost, because a
 * rotation only starts when everything up to `from` is already committed.
 */
export function recoverRotation(cur: Cursor, now: number): boolean {
	const r = cur.rotating;
	if (!r) return false;
	if (existsSync(r.path)) {
		cur.retired.push({ path: r.path, offset: r.from, after: now + 60_000 });
		cur.offset = 0;
		cur.inode = 0;
	}
	cur.rotating = undefined;
	return true;
}

/**
 * Renames a big inbox away, but only once everything in it is committed (the saved cursor is at its end). The intent is saved BEFORE the
 * rename, and the retired file is in a saved cursor BEFORE anything reads or deletes it, so no crash between the steps loses a line.
 */
export function rotateIfDue(
	cur: Cursor,
	{ inbox, now, cfg }: { inbox: string; now: number; cfg: DeskConfig },
	{ save, crash = () => {} }: { save: () => void; crash?: (p: CrashPoint) => void },
): boolean {
	let stat: Stats;
	try {
		stat = statSync(inbox);
	} catch {
		return false;
	}
	if (cur.inode === 0 || stat.ino !== cur.inode || cur.offset < stat.size || stat.size <= cfg.rotateBytes) return false;
	const path = `${inbox}.${now}`;
	cur.rotating = { path, from: cur.offset, inode: cur.inode };
	save();
	crash("rotation-intent");
	try {
		renameSync(inbox, path);
	} catch {
		cur.rotating = undefined;
		save();
		return false;
	}
	crash("renamed");
	recoverRotation(cur, now);
	save();
	crash("rotation-saved");
	return true;
}

/** Deletes a retired file a crash left behind after its cursor was saved (named `<inbox>.<ms>`, in no list, and old enough that no pass can still own it). */
export function sweepStrays(cur: Cursor, inbox: string, now: number): void {
	const dir = dirname(inbox),
		base = `${basename(inbox)}.`;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		if (!n.startsWith(base) || !/^\d+$/.test(n.slice(base.length))) continue;
		const path = `${dir}/${n}`;
		if (
			now - Number(n.slice(base.length)) < 10 * 60_000 ||
			cur.retired.some((x) => x.path === path) ||
			cur.rotating?.path === path
		)
			continue;
		try {
			unlinkSync(path);
		} catch {
			/* gone */
		}
	}
}

/** Reads the next chunk of every retired file that is due into `lines`; returns the ones now read to their end (or gone). */
function readRetiredFiles(cur: Cursor, now: number, lines: string[]): Retired[] {
	const retiredRead: Retired[] = [];
	for (const r of cur.retired) {
		if (now < r.after) continue;
		const got = readLines(r.path, r.offset, true);
		if (!got) {
			retiredRead.push(r);
			continue;
		}
		lines.push(...got.lines);
		// Progress is recorded only up to the bytes actually read. The file is finished, and may be deleted once the cursor is saved, only when
		// that is its end: a bigger file than one chunk is read over the next passes.
		r.offset = got.end;
		if (got.end >= got.size) retiredRead.push(r);
	}
	return retiredRead;
}

/** Reads what is new in the inbox itself into `lines`, advancing the cursor. */
function readLiveInbox(cur: Cursor, inbox: string, lines: string[]): void {
	const main = readLines(inbox, cur.inode === 0 ? 0 : cur.offset);
	if (!main) return;
	// A different file at the same path (rotated by hand, or recreated): its start is new to us.
	const fresh = cur.inode !== 0 && cur.inode !== main.inode ? (readLines(inbox, 0) ?? main) : main;
	lines.push(...fresh.lines);
	cur.offset = fresh.end;
	cur.inode = fresh.inode;
}

/** The events in `lines`, oldest first, and how many lines were not events or were older than `maxAgeMs`. */
function parseEvents(
	lines: string[],
	now: number,
	maxAgeMs: number,
): { events: DeskEvent[]; bad: number; stale: number } {
	let bad = 0,
		stale = 0;
	const events: DeskEvent[] = [];
	for (const l of lines) {
		const e = parseLine(l);
		if (!e) {
			bad++;
			continue;
		}
		if (now - Date.parse(e.ts) > maxAgeMs) {
			stale++;
			continue;
		}
		events.push(e);
	}
	events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	return { events, bad, stale };
}

/**
 * Reads what is new in the inbox, and the next chunk of every retired file that is due, advancing `cur` and the retired offsets in memory.
 * Nothing is renamed or deleted here: the caller saves the cursor first. Events are oldest first.
 */
export function readInbox(cur: Cursor, inbox: string, now: number, cfg: DeskConfig): Read {
	const lines: string[] = [];
	const retiredRead = readRetiredFiles(cur, now, lines);
	readLiveInbox(cur, inbox, lines);
	return { ...parseEvents(lines, now, cfg.maxAgeMs), retiredRead };
}

// ---- the decision, in the item system ---------------------------------------------------------------

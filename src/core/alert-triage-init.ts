/** Flag-on init: rotate the existing inbox aside via legacy `rotating` so flag-off can recover (M5). */
import { existsSync, renameSync, statSync } from "node:fs";
import type { CrashPoint, Cursor, Retired } from "./alert-desk-cursor.ts";
import { inboxMsSiblings, recoverRotation } from "./alert-desk-cursor.ts";

/** Adopt stray `<inbox>.<ms>` files as preInit retired entries before sweepStrays can delete them. */
function adoptStrays(cur: Cursor, inbox: string, now: number): void {
	for (const { path } of inboxMsSiblings(inbox)) {
		if (cur.retired.some((x) => x.path === path) || cur.rotating?.path === path) continue;
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {
			continue;
		}
		const entry: Retired = { path, offset: 0, after: now, preInit: true, preInitUntil: size };
		cur.retired.push(entry);
	}
}

type InitArgs = {
	cur: Cursor;
	inbox: string;
	now: number;
	save: () => void;
	crash: (p: CrashPoint) => void;
};

/**
 * No stored cursor + flag on: rename the live inbox aside using `rotating` (legacy-recoverable, M5),
 * stamp preInitUntil at rename (saved before crash) so lingering-writer appends stay post-init (M2/M6).
 */
export function triageInit(a: InitArgs): void {
	adoptStrays(a.cur, a.inbox, a.now);
	if (a.cur.rotating) {
		recoverRotation(a.cur, a.now);
		a.save();
		return;
	}
	a.cur.offset = 0;
	a.cur.inode = 0;
	if (!existsSync(a.inbox)) {
		a.save();
		return;
	}
	const path = `${a.inbox}.${a.now}`;
	a.cur.initAdopt = true;
	a.cur.rotating = { path, from: 0, inode: 0 };
	a.save();
	a.crash("triage-init");
	try {
		renameSync(a.inbox, path);
	} catch {
		a.cur.rotating = undefined;
		a.cur.initAdopt = undefined;
		a.save();
		return;
	}
	try {
		if (a.cur.rotating) a.cur.rotating.preInitUntil = statSync(path).size;
	} catch {
		/* size unknown: recovery falls back to live size */
	}
	a.save(); // boundary must survive triage-init-renamed (M2)
	a.crash("triage-init-renamed");
	recoverRotation(a.cur, a.now);
	a.save();
}

/** The one lock all worktrees of a clone share for the heavy hook work: taking it, reclaiming one a dead process left, releasing it. */
import { linkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_TIMEOUT_MS, readLines, stateDir } from "./hooks.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ownerOf(path: string): number {
	return Number(readLines(path)[0]) || 0;
}

/**
 * Takes the lock: a file holding our pid, put in place with link(2), which fails if it exists and leaves no moment when
 * the file exists empty. A lock whose owner is gone is moved aside (rename is atomic, so one waiter wins it) and the
 * attempt is made again by the caller's loop.
 */
export function takeLock(path: string): boolean {
	const mine = `${path}.${process.pid}.${Date.now()}`;
	writeFileSync(mine, String(process.pid));
	try {
		linkSync(mine, path);
		return true;
	} catch {
		reclaimIfDead(path);
		return false;
	} finally {
		rmSync(mine, { force: true });
	}
}

function reclaimIfDead(path: string): void {
	const owner = ownerOf(path);
	if (owner && alive(owner)) return;
	const aside = `${path}.stale.${process.pid}.${Date.now()}`;
	try {
		renameSync(path, aside);
	} catch {
		return; // another waiter moved it first
	}
	// If a live lock was swapped in between our read and the rename, put it back.
	if (ownerOf(aside) !== owner) {
		try {
			linkSync(aside, path);
		} catch {
			// a newer lock is already in place: nothing to restore
		}
	}
	rmSync(aside, { force: true });
}

/** Removes the lock only when it is ours. */
export function releaseLock(path: string): void {
	if (ownerOf(path) === process.pid) rmSync(path, { force: true });
}

export async function withLock(job: () => Promise<number>): Promise<number> {
	const path = join(stateDir(), "heavy.lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (!takeLock(path)) {
		if (Date.now() > deadline) {
			console.error(`hooks: timed out waiting for ${path}. Another worktree is running the checks; wait for it.`);
			return 1;
		}
		await Bun.sleep(1000);
	}
	process.on("SIGINT", () => {
		releaseLock(path);
		process.exit(130);
	});
	try {
		return await job();
	} finally {
		releaseLock(path);
	}
}

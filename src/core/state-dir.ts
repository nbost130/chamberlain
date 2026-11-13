/**
 * Where Chamberlain's directories are, by the XDG Base Directory Specification
 * (https://specifications.freedesktop.org/basedir/latest/):
 *
 *   config   $CHAMBERLAIN_CONF, else $XDG_CONFIG_HOME/chamberlain, else ~/.config/chamberlain
 *   state    $CHAMBERLAIN_STATE, else $XDG_STATE_HOME/chamberlain, else ~/.local/state/chamberlain
 *
 * State is "state data that should persist between restarts": the database (rulings and the decision log are in it), the
 * evidence files its rows point to, and the hand-off. It is not a cache: nothing here may be wiped by the OS or a cleanup tool.
 * A real cache would go under $XDG_CACHE_HOME/chamberlain; Chamberlain keeps none today.
 *
 * The specification says a variable holding a relative path is invalid and must be ignored, and so does an empty one.
 */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { FlockBusyError, holdFlock } from "./singleton.ts";
import { foldWal } from "./sqlite-store.ts";
import { DB_FILE } from "./store.ts";

type Env = Record<string, string | undefined>;

/** An environment value that may name a directory: set, non-empty and absolute (the XDG rule). */
const usable = (v: string | undefined): v is string => v !== undefined && v !== "" && isAbsolute(v);

/** Pure: the directory a Chamberlain override variable or an XDG base variable names, with the default under `home`. */
function resolve(env: Env, override: string, xdg: string, fallback: string, home: string): string {
	if (usable(env[override])) return env[override]!;
	if (usable(env[xdg])) return `${env[xdg]!.replace(/\/+$/, "")}/chamberlain`;
	return `${home}/${fallback}/chamberlain`;
}

export const configDir = (env: Env, home: string) => resolve(env, "CHAMBERLAIN_CONF", "XDG_CONFIG_HOME", ".config", home);
export const stateDir = (env: Env, home: string) => resolve(env, "CHAMBERLAIN_STATE", "XDG_STATE_HOME", ".local/state", home);

/**
 * Pure: the directories an earlier build kept its state in, newest convention first: the directory CHAMBERLAIN_CACHE named,
 * then the XDG cache directory, then ~/.cache/chamberlain. (Before the state directory existed, the database lived in the cache.)
 */
export function legacyCacheDirs(env: Env, home: string): string[] {
	const out = [env.CHAMBERLAIN_CACHE, usable(env.XDG_CACHE_HOME) ? `${env.XDG_CACHE_HOME.replace(/\/+$/, "")}/chamberlain` : undefined, `${home}/.cache/chamberlain`];
	return [...new Set(out.filter((d): d is string => usable(d)))];
}

// ---- the one-time move out of the cache directory ---------------------------------------------------

/** What moves with the database: the evidence files its rows point to, and the hand-off. */
const COMPANIONS = ["evidence", "steward-brief.md"];

export type StateMove = { from: string; to: string; moved: string[] };

/** Moves one path. A rename where it can; across file systems a copy that is checked before the original goes. */
function movePath(src: string, dst: string) {
	if (!existsSync(src)) return;
	mkdirSync(dst.slice(0, dst.lastIndexOf("/")), { recursive: true, mode: 0o700 });
	if (lstatSync(src).isDirectory() && existsSync(dst)) {
		// A half-finished earlier move: carry over what is not there yet.
		for (const name of readdirSync(src)) movePath(`${src}/${name}`, `${dst}/${name}`);
		try { rmSync(src, { recursive: false }); } catch { /* not empty: something stayed behind, which is fine */ }
		return;
	}
	if (existsSync(dst)) return;
	try {
		renameSync(src, dst);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
		if (lstatSync(src).isDirectory()) cpSync(src, dst, { recursive: true, errorOnExist: true });
		else copyFileSync(src, dst);
		if (statSync(dst).size !== statSync(src).size && !lstatSync(src).isDirectory()) throw Error(`copy of ${src} is not the same size`);
		rmSync(src, { recursive: true });
	}
}

/**
 * If an older build left a database in `legacy` and `state` has none, moves it (and the evidence and the hand-off) into
 * `state`, once. Returns what moved, or undefined when there was nothing to do. Safe to race: whoever takes the lock moves, the rest
 * wait and then find the database where it belongs. The database moves LAST, so a crash half way leaves the old one in place
 * and the next start finishes the job.
 *
 * The old database is first checkpointed (its write-ahead log folded into the main file), so that no `-wal` or `-shm`
 * file has to travel with it; if another process still has it open, the move is refused with a message, never forced.
 */
export function moveStateOutOfCache(state: string, legacy: readonly string[], opts: { waitMs?: number; busyMs?: number } = {}): StateMove | undefined {
	const target = `${state}/${DB_FILE}`;
	if (existsSync(target)) return undefined;
	const from = legacy.find((d) => existsSync(`${d}/${DB_FILE}`));
	if (!from) return undefined;
	mkdirSync(state, { recursive: true, mode: 0o700 });
	// The move lock is a kernel flock on the state directory (singleton.ts `holdFlock`), the same mechanism as the relay's and the config migration's:
	// it belongs to the open file description, so it is released when the holder closes it or dies, however it dies. There is no marker file to
	// leave behind, age out or break. Another mover is waited for (the database is then where it belongs: the check below returns), and a holder
	// still there when the wait is over is refused, never forced.
	const waitMs = opts.waitMs ?? 15_000;
	let lock: { release(): void };
	try {
		lock = holdFlock(state, { waitMs });
	} catch (e) {
		if (e instanceof FlockBusyError) throw Error(`${state} is still locked after ${waitMs / 1000}s: another Chamberlain process is moving the database from ${from}. The lock is released when that process ends.`);
		throw e;
	}
	try {
		if (existsSync(target)) return undefined;
		if (!foldWal(`${from}/${DB_FILE}`, opts.busyMs)) throw Error(`the database ${from}/${DB_FILE} is in use by another process: stop Chamberlain (the daemon and the page) and start it again to move it to ${state}`);
		const moved: string[] = [];
		for (const name of COMPANIONS) if (existsSync(`${from}/${name}`)) { movePath(`${from}/${name}`, `${state}/${name}`); moved.push(name); }
		movePath(`${from}/${DB_FILE}`, target);
		moved.push(DB_FILE);
		// The checkpoint left the write-ahead log empty; its leftovers are no use without the database they belonged to.
		for (const side of [`${from}/${DB_FILE}-wal`, `${from}/${DB_FILE}-shm`]) { try { if (existsSync(side) && statSync(side).size === 0) unlinkSync(side); } catch { /* not ours */ } }
		return { from, to: state, moved };
	} finally {
		lock.release();
	}
}

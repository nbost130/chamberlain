/**
 * One relay per database, enforced by the operating system and keyed on the database file itself: the daemon holds a `flock(2)` exclusive
 * lock (`LOCK_EX | LOCK_NB`) on `chamberlain.db` through one descriptor that it keeps open for its whole life. There is no lock file.
 *
 * Why `flock` and not POSIX `fcntl` record locks: a `flock` lock belongs to the OPEN FILE DESCRIPTION, not to the process. So
 *   - opening and closing some other descriptor to the database in the same process (SQLite does this, and so did a refused second
 *     acquisition under the old `fcntl` lock) does not release it, and a second `open` plus `flock` in the same process is refused;
 *   - it belongs to the file's inode, not to a path: `state`, `state/`, a symlink, a hard link, a relative or a very long path are one
 *     file and one lock, and no environment variable (`XDG_RUNTIME_DIR`, `TMPDIR`, a working directory) takes part in naming it;
 *   - the kernel releases it when the last descriptor to that open file description closes, which is when the holder exits, however it
 *     exits (a kill, a crash): no clock, pid, boot id or host name decides anything, and nothing has to be cleaned up.
 *
 * What keeps a child from holding the lock: the descriptor is opened close-on-exec (Bun opens every file so), so a child the daemon
 * EXECs (`Bun.spawn`, `execFile`, `spawn`: each is a fork followed by an exec) does not inherit it and cannot keep the lock alive after the
 * daemon dies. Close-on-exec does nothing for a fork WITHOUT an exec: such a child would share the open file description, and with it the
 * lock, until it exited or closed it, so the lock could outlive the daemon. No production path forks without exec: the only foreign code
 * this process calls through `bun:ffi` is `flock` and `errno` (src/core/guarantee-docs.test.ts checks), and every child it starts is exec'd.
 *
 * It does not get in SQLite's way: SQLite's `unix` VFS (the default) locks with `fcntl` byte ranges, and on Linux and macOS `flock` and
 * `fcntl` locks are independent, so the page and the tools read and write the database while the relay holds it.
 *
 * `flock` is called through `bun:ffi` against the C library (`libc.so.6` on Linux, `libSystem.B.dylib` on macOS); no dependency is added.
 * Where it cannot be loaded, the relay refuses to start (RelayLockUnavailableError): there is no fallback.
 *
 * A descriptor to the database is never closed, not even after a release or a refusal, because closing ANY descriptor to a file drops
 * every POSIX `fcntl` lock this process holds on it, and those are SQLite's own locks (https://www.sqlite.org/howtocorrupt.html, 2.2).
 * One descriptor per database is opened, parked and reused. A module-level guard also refuses a second acquisition in this process
 * without opening anything.
 *
 * Limits (also in ARCHITECTURE.md): the lock is per machine and per kernel, on a local filesystem. File locks on a network filesystem
 * (NFS, SMB) are not reliable, and Linux emulates `flock` there with `fcntl` locks, so a state directory on one is unsupported;
 * `networkFilesystem` lets the daemon say so at start. Replacing or deleting `chamberlain.db` while the daemon runs makes a different
 * database, with its own lock.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { FILE_MODE } from "./private.ts";
import { requireTestEnv } from "./test-env.ts";

/** flock(2) operations, the same on Linux and macOS (<sys/file.h>). */
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
const EINTR = 4;
/** EWOULDBLOCK, which is EAGAIN on both: 11 on Linux (glibc and musl), 35 on macOS (<sys/errno.h>). */
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

/** `flock(int fd, int operation)` and the calling thread's errno. */
export type Flock = { flock(fd: number, op: number): number; errno(): number };

/** The C libraries that hold `flock` on this platform, in the order they are tried. Empty where the relay lock is not supported. */
export function libcCandidates(platform: string = process.platform, arch: string = process.arch): string[] {
	if (platform === "linux") return ["libc.so.6", `libc.musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
	if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib", "libSystem.B.dylib"];
	return [];
}

/** The relay cannot take its lock on this platform: no flock to call. The relay must not start without it. */
export class RelayLockUnavailableError extends Error {
	constructor(why: string) {
		super(`chamberlain cannot take the one-relay lock on this platform (${why}). The relay needs flock(2) through bun:ffi, on Linux or macOS; refusing to start rather than run without it.`);
		this.name = "RelayLockUnavailableError";
	}
}

/** Loads `flock` and errno from the first C library that has them, or throws RelayLockUnavailableError. */
export function loadFlock(candidates: string[] = libcCandidates(), platform: string = process.platform): Flock {
	if (candidates.length === 0) throw new RelayLockUnavailableError(`platform ${platform} is not supported`);
	const errnoSymbol = platform === "darwin" ? "__error" : "__errno_location";
	const tried: string[] = [];
	for (const name of candidates) {
		try {
			const lib = dlopen(name, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				[errnoSymbol]: { args: [], returns: FFIType.ptr },
			});
			const flock = lib.symbols.flock as (fd: number, op: number) => number;
			const errnoAt = lib.symbols[errnoSymbol] as () => Pointer | null;
			return { flock: (fd, op) => flock(fd, op), errno: () => { const at = errnoAt(); return at ? read.i32(at, 0) : -1; } };
		} catch (e) {
			tried.push(`${name}: ${String((e as Error).message ?? e).slice(0, 120)}`);
		}
	}
	throw new RelayLockUnavailableError(`no usable flock: ${tried.join("; ")}`);
}

let loaded: Flock | undefined;

export class RelayRunningError extends Error {
	constructor(readonly lock: string) {
		super(`another chamberlain daemon is already running on this database (it holds a lock on ${lock}); only one may relay wakes. Stop it first, or point CHAMBERLAIN_STATE elsewhere.`);
	}
}

/**
 * The handle of a held relay lock. It is what the code that sends wakes must be given: `createRelay` and `createEngine` take one, so a
 * relay cannot be built without having acquired the lock. It records the device and inode of the file it locked (`identity`), and
 * `createRelay` refuses it unless that is the database file the store opened (`lockCovers`): a lock on some other database authorizes nothing. The `acquired` brand is a unique symbol this module does not export, so no object
 * literal can satisfy the type (a cast can, and so `isRelayLock` also checks at run time that `holdRelayLock` made the value).
 */
declare const acquired: unique symbol;
export type RelayLock = {
	readonly path: string;
	/** The device and inode of the file this handle locked (`dev:ino`), recorded when it was taken: what `lockCovers` checks a store's database against. */
	readonly identity: string;
	/** False once `release()` has run: the holder may no longer send. */
	held(): boolean;
	release(): void;
	readonly [acquired]: true;
};

/** The handles `holdRelayLock` has made. The only way into this set is that function, whatever a caller casts. */
const issued = new WeakSet<object>();
/** True for a handle `holdRelayLock` returned (not for a look-alike object, however it is typed). */
export const isRelayLock = (x: unknown): x is RelayLock => typeof x === "object" && x !== null && issued.has(x);

/** A file's identity: device and inode. Two paths name one file exactly when these match. */
const fileKey = (st: { dev: number | bigint; ino: number | bigint }) => `${st.dev}:${st.ino}`;

/** What a test handle for an in-memory store is bound to: a store with no file has no inode, so only a test handle can cover it. */
const MEMORY = "memory";

/**
 * True when `lock` is the lock on the database file at `dbPath`: the device and inode the handle recorded when it locked its file are those of
 * the file at `dbPath` now (the path the store opened, so a symlink, a relative path or a hard link to the same file all match). A lock on any
 * other file covers nothing, and neither does a file that cannot be read. An in-memory store (`:memory:`, tests only) is covered by the memory
 * test handle alone, and a file store never is.
 */
export function lockCovers(lock: RelayLock, dbPath: string): boolean {
	if (dbPath === ":memory:") return lock.identity === MEMORY;
	try { return lock.identity === fileKey(statSync(dbPath)); } catch { return false; }
}
/** The database files this process holds the relay lock on. */
const held = new Set<string>();
/** One descriptor per database file this process has opened for the lock, kept open for the life of the process (see the header). */
const parked = new Map<string, number>();
/** Descriptors opened in a race and never used (see holdRelayLock): kept open, never closed, for the reason in the header. */
const strays: number[] = [];

/** The database's path as SQLite opens it (symlinks resolved), for messages. */
function realPath(db: string): string {
	const abs = resolve(db);
	try { return realpathSync(abs); } catch { /* not there yet */ }
	try { return `${realpathSync(dirname(abs))}/${abs.slice(abs.lastIndexOf("/") + 1)}`; } catch { return abs; }
}

/**
 * Takes the relay's lock on the database file at `db`, or throws RelayRunningError at once (it never waits). Synchronous. The file is
 * created (empty, mode 0600) if it does not exist yet. The lock is held until `release()` or until the process ends. Throws
 * RelayLockUnavailableError, having opened nothing, where `flock` cannot be loaded. `o.lib` is a seam for tests.
 */
export function holdRelayLock(db: string, o: { lib?: () => Flock } = {}): RelayLock {
	const path = realPath(db);
	// Defense in depth: a second acquisition in this process is refused before anything is opened.
	let before: string | undefined;
	try { before = fileKey(statSync(db)); } catch { /* not there yet */ }
	if (before && held.has(before)) throw new RelayRunningError(path);
	const lib = o.lib ? o.lib() : (loaded ??= loadFlock());
	let fd = before === undefined ? undefined : parked.get(before);
	if (fd === undefined) {
		fd = openSync(db, constants.O_RDONLY | constants.O_CREAT, FILE_MODE);
		const key = fileKey(fstatSync(fd));
		// The file appeared between the stat and the open, and it is one this process already has open: use that descriptor, keep this one.
		const known = parked.get(key);
		if (known === undefined) parked.set(key, fd);
		else { strays.push(fd); fd = known; }
	}
	const key = fileKey(fstatSync(fd));
	if (held.has(key)) throw new RelayRunningError(path);
	let r = lib.flock(fd, LOCK_EX | LOCK_NB);
	for (let i = 0; r !== 0 && i < 100 && lib.errno() === EINTR; i++) r = lib.flock(fd, LOCK_EX | LOCK_NB);
	if (r !== 0) {
		const errno = lib.errno();
		if (errno === EWOULDBLOCK) throw new RelayRunningError(path);
		throw new Error(`flock(${path}) failed with errno ${errno}; refusing to start the relay`);
	}
	held.add(key);
	const lockedFd = fd;
	let released = false;
	const handle = {
		path,
		identity: key,
		held: () => !released,
		release() {
			if (released) return;
			released = true;
			lib.flock(lockedFd, LOCK_UN);
			held.delete(key);
		},
	} as RelayLock;
	issued.add(handle);
	return handle;
}

/**
 * TEST ONLY (called by src/testing/lock.ts alone; src/architecture.test.ts checks, and it throws unless the process is a test run: test-env.ts).
 * A handle that is NOT a kernel lock, bound to `db` exactly as a real one is: to the file's device and inode, or to nothing but an in-memory
 * store for ":memory:". Hundreds of in-process tests cannot all contend for one real `flock`, and several relays over one scratch database
 * (a "restart") must be able to coexist. Everything that checks the handle (isRelayLock, held, lockCovers) treats it as a real one.
 */
export function holdTestRelayLock(db: string): RelayLock {
	requireTestEnv("holdTestRelayLock");
	const identity = db === ":memory:" ? MEMORY : fileKey(statSync(db));
	let released = false;
	const handle = { path: db, identity, held: () => !released, release() { released = true; } } as RelayLock;
	issued.add(handle);
	return handle;
}

/** Nothing got the lock within the wait: another open file description holds it. */
export class FlockBusyError extends Error {
	constructor(readonly path: string, readonly waitedMs: number) {
		super(`${path} is locked by another process (waited ${waitedMs} ms)`);
		this.name = "FlockBusyError";
	}
}

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Takes an exclusive `flock(2)` on `path`, a directory or a file that is NOT a database (it is opened read-only and closed on release; closing a
 * descriptor to a SQLite file would drop SQLite's own locks, which is why the relay's lock never closes its descriptor), waits up to
 * `waitMs` for the holder, and throws FlockBusyError if it is still held. Synchronous: it polls `LOCK_NB` every 25 ms rather than blocking the
 * thread in the kernel, so the timeout is real. The kernel owns the lock: it belongs to this open file description and is gone when the holder
 * closes it or dies, however it dies, so nothing is ever broken, aged out or cleaned up, and no one can release another process's lock.
 * Throws RelayLockUnavailableError where `flock` cannot be called. `o.lib` is a seam for tests. Used by the config migration (migrate.ts).
 */
export function holdFlock(path: string, o: { waitMs: number; lib?: () => Flock }): { release(): void } {
	const lib = o.lib ? o.lib() : (loaded ??= loadFlock());
	const fd = openSync(path, constants.O_RDONLY);
	const started = Date.now();
	try {
		for (;;) {
			let r = lib.flock(fd, LOCK_EX | LOCK_NB);
			for (let i = 0; r !== 0 && i < 100 && lib.errno() === EINTR; i++) r = lib.flock(fd, LOCK_EX | LOCK_NB);
			if (r === 0) break;
			const errno = lib.errno();
			if (errno !== EWOULDBLOCK) throw new Error(`flock(${path}) failed with errno ${errno}`);
			const waited = Date.now() - started;
			if (waited >= o.waitMs) throw new FlockBusyError(path, waited);
			sleepSync(Math.min(25, Math.max(1, o.waitMs - waited)));
		}
	} catch (e) { closeSync(fd); throw e; }
	let released = false;
	return { release() { if (released) return; released = true; lib.flock(fd, LOCK_UN); closeSync(fd); } };
}

/** Filesystem types whose POSIX locks do not work reliably across clients. */
const NETWORK_FS = /^(nfs\d?|cifs|smb3?|smbfs|afs|afpfs|9p|ncpfs|webdav|ceph|glusterfs|lustre|fuse\.sshfs|fuse\.glusterfs|fuse\.nfs|fuse\.cephfs|fuse\.rclone|fuse\.s3fs|fuse\.davfs|ocfs2|gfs2)$/i;

/** The octal escapes /proc/self/mountinfo uses for spaces and the like in a mount point. */
const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/**
 * The network filesystem type that `path` is on, from the text of /proc/self/mountinfo (Linux) or `mount` (macOS), or undefined. The longest
 * mount point that is a prefix of the path wins. Pure, so tests can feed it text.
 */
export function networkFilesystemIn(path: string, mounts: { linux?: string; mac?: string }): string | undefined {
	let best: { at: number; type: string } | undefined;
	const consider = (point: string, type: string) => {
		const inside = point === "/" || path === point || path.startsWith(`${point}/`);
		if (inside && (!best || point.length > best.at)) best = { at: point.length, type };
	};
	for (const line of (mounts.linux ?? "").split("\n")) {
		// "36 35 98:0 /root /mnt/point opts - fstype source superopts": the type follows the " - " separator.
		const [pre, post] = line.split(" - ");
		const f = pre?.split(" ");
		const type = post?.split(" ")[0];
		if (f && f.length > 4 && type) consider(unescapeMount(f[4]!), type);
	}
	for (const line of (mounts.mac ?? "").split("\n")) {
		// "//user@host/share on /Volumes/share (smbfs, nodev, nosuid)"
		const m = /^.+ on (.+) \(([^,)]+)/.exec(line);
		if (m) consider(m[1]!, m[2]!);
	}
	const found = best as { at: number; type: string } | undefined;
	return found && NETWORK_FS.test(found.type) ? found.type : undefined;
}

/** The network filesystem the directory is on, or undefined (also when it cannot be told: this check only ever warns). Best effort, cheap, no network access. */
export function networkFilesystem(dir: string): string | undefined {
	try {
		const real = realpathSync(dir);
		if (process.platform === "linux") return networkFilesystemIn(real, { linux: readFileSync("/proc/self/mountinfo", "utf8") });
		if (process.platform === "darwin") return networkFilesystemIn(real, { mac: execFileSync("/sbin/mount", { encoding: "utf8", timeout: 2000 }) });
	} catch { /* unknown: say nothing */ }
	return undefined;
}

/**
 * One relay per state directory, enforced by the operating system and keyed on the directory that holds the database: the daemon opens that
 * directory read-only and holds a `flock(2)` exclusive lock (`LOCK_EX | LOCK_NB`) on that descriptor for its whole life. There is no lock
 * file, and nothing is ever created beside the database for it.
 *
 * Why the directory and not `chamberlain.db` itself: SQLite locks the database file with POSIX `fcntl` byte ranges, and on macOS, as on the
 * BSDs, `flock` and `fcntl` locks on one file DO conflict. FreeBSD's flock(2): "If a file is locked by a process through flock(), any record
 * within the file will be seen as locked from the viewpoint of another process using fcntl(2) or lockf(3), and vice versa"; Linux's
 * flock(2): "on some systems, such as the modern BSDs, flock() and fcntl(2) locks do interact with one another". macOS's own flock(2) page
 * is silent, so the behaviour was probed on macOS 26 (Darwin arm64): a `flock` on the database is refused (EWOULDBLOCK) while any SQLite
 * connection holds a shared lock on it, the daemon's own connection in the same process included, and while a `flock` is held SQLite's
 * writers get "database is locked". On Linux the two kinds are independent, which is why only macOS showed it. SQLite never takes a lock on a directory, so a lock on the directory meets none of SQLite's on either system
 * (src/core/singleton.test.ts checks this on the platform it runs on).
 *
 * Why `flock` and not POSIX `fcntl` record locks: a `flock` lock belongs to the OPEN FILE DESCRIPTION, not to the process. So
 *   - opening and closing some other descriptor to the directory or the database in the same process (SQLite does both) does not release
 *     it, and a second `open` plus `flock` in the same process is refused;
 *   - it belongs to the directory's inode, not to a path: `state`, `state/`, a symlink to the directory or to the database, a relative or a
 *     very long path, and the directory renamed under a live holder are one lock, and no environment variable (`XDG_RUNTIME_DIR`, `TMPDIR`,
 *     a working directory) takes part in naming it;
 *   - the kernel releases it when the last descriptor to that open file description closes, which is when the holder exits, however it
 *     exits (a kill, a crash): no clock, pid, boot id or host name decides anything, and nothing has to be cleaned up.
 *
 * What keeps a child from holding the lock: the descriptor is opened close-on-exec (Bun opens every file so), so a child the daemon
 * EXECs (`Bun.spawn`, `execFile`, `spawn`: each is a fork followed by an exec) does not inherit it and cannot keep the lock alive after the
 * daemon dies. Close-on-exec does nothing for a fork WITHOUT an exec: such a child would share the open file description, and with it the
 * lock, until it exited or closed it, so the lock could outlive the daemon. No production path forks without exec: the only foreign code
 * this process calls through `bun:ffi` is `flock` and `errno` (src/core/guarantee-docs.test.ts checks), and every child it starts is exec'd.
 *
 * The handle is bound to the directory's device and inode AND the database's (`identity`, `lockCovers`), so a relay built over a database
 * that is not the one in the locked directory, or over a file that has replaced it, is refused. A database with more than one hard link is
 * refused at start (RelayDatabaseLinkedError): a link in another directory would otherwise be the same database under another lock.
 *
 * `flock` is called through `bun:ffi` against the C library (`libc.so.6` on Linux, `libSystem.B.dylib` on macOS); no dependency is added.
 * Where it cannot be loaded, the relay refuses to start (RelayLockUnavailableError): there is no fallback.
 *
 * The directory descriptor is closed on release or refusal: SQLite holds no lock on a directory, so closing it costs SQLite nothing. A
 * descriptor to the DATABASE is another matter: closing any descriptor to a file drops every POSIX `fcntl` lock this process holds on it,
 * and those are SQLite's own (https://www.sqlite.org/howtocorrupt.html, 2.2). So this module opens the database only to create it when it
 * does not exist yet, and never closes that descriptor. A module-level guard also refuses a second acquisition in this process without
 * opening anything.
 *
 * Limits (also in ARCHITECTURE.md): the lock is per machine and per kernel, on a local filesystem. File locks on a network filesystem
 * (NFS, SMB) are not reliable, and Linux emulates `flock` there with `fcntl` locks, so a state directory on one is unsupported;
 * `networkFilesystem` lets the daemon say so at start. Replacing or deleting `chamberlain.db` while the daemon runs makes a different
 * database, and moving it to another directory puts it under that directory's lock.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { FILE_MODE } from "./private.ts";
import { requireTestEnv } from "./test-env.ts";

/** flock(2) operations, the same on Linux and macOS (<sys/file.h>). */
const LOCK_EX = 2,
	LOCK_NB = 4,
	LOCK_UN = 8;
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
		super(
			`chamberlain cannot take the one-relay lock on this platform (${why}). The relay needs flock(2) through bun:ffi, on Linux or macOS; refusing to start rather than run without it.`,
		);
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
			return {
				flock: (fd, op) => flock(fd, op),
				errno: () => {
					const at = errnoAt();
					return at ? read.i32(at, 0) : -1;
				},
			};
		} catch (e) {
			tried.push(`${name}: ${String((e as Error).message ?? e).slice(0, 120)}`);
		}
	}
	throw new RelayLockUnavailableError(`no usable flock: ${tried.join("; ")}`);
}

let loaded: Flock | undefined;

export class RelayRunningError extends Error {
	constructor(readonly lock: string) {
		super(
			`another chamberlain daemon is already running on this database (it holds the lock on its state directory, ${lock}); only one may relay wakes. Stop it first, or point CHAMBERLAIN_STATE elsewhere.`,
		);
	}
}

/** The database has more than one hard link. The relay's lock is on the database's directory, so a link elsewhere would be a second lock. */
export class RelayDatabaseLinkedError extends Error {
	constructor(
		readonly db: string,
		readonly links: number,
	) {
		super(
			`${db} has ${links} hard links. The one-relay lock is on the directory that holds the database, so a link to it in another directory would let a second relay in. Refusing to start: remove the other links and start again.`,
		);
		this.name = "RelayDatabaseLinkedError";
	}
}

/**
 * The handle of a held relay lock. It is what the code that sends wakes must be given: `createRelay` and `createEngine` take one, so a
 * relay cannot be built without having acquired the lock. It records the device and inode of the directory it locked and of the database
 * file in it (`identity`), and `createRelay` refuses it unless that is the database file the store opened, in that directory (`lockCovers`):
 * a lock on some other directory or database authorizes nothing. The `acquired` brand is a unique symbol this module does not export, so no
 * object literal can satisfy the type (a cast can, and so `isRelayLock` also checks at run time that `holdRelayLock` made the value).
 */
declare const acquired: unique symbol;
export type RelayLock = {
	/** The database file, symlinks resolved, when the lock was taken. */
	readonly path: string;
	/** The directory the lock is held on (the database's own directory), symlinks resolved, when the lock was taken. */
	readonly directory: string;
	/** `<directory dev:ino> <database dev:ino>`, recorded when it was taken: what `lockCovers` checks a store's database against. */
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

/** Where the database at `db` really is: its directory and its path, symlinks resolved (the file need not exist yet; its directory must). */
function locate(db: string): { dir: string; path: string } {
	const abs = resolve(db);
	try {
		const real = realpathSync(abs);
		return { dir: dirname(real), path: real };
	} catch {
		/* not there yet */
	}
	const dir = realpathSync(dirname(abs));
	return { dir, path: `${dir}/${basename(abs)}` };
}

/** The identity a lock on the database at `db` records: its directory's device and inode, then its own. Throws when either cannot be read. */
function identityOf(db: string): string {
	const { dir, path } = locate(db);
	return `${fileKey(statSync(dir))} ${fileKey(statSync(path))}`;
}

/**
 * True when `lock` is the lock on the database file at `dbPath`: the devices and inodes the handle recorded (the directory it locked and the
 * database in it) are those of the file at `dbPath` now and of the directory that holds it (symlinks resolved, so a symlink or a relative
 * path to the same file matches). A lock on any other directory or file covers nothing, and neither does a file that cannot be read. An
 * in-memory store (`:memory:`, tests only) is covered by the memory test handle alone, and a file store never is.
 */
export function lockCovers(lock: RelayLock, dbPath: string): boolean {
	if (dbPath === ":memory:") return lock.identity === MEMORY;
	try {
		return lock.identity === identityOf(dbPath);
	} catch {
		return false;
	}
}
/** The directories (`dev:ino`) this process holds the relay lock on. */
const held = new Set<string>();
/** Descriptors to a database this module created (holdRelayLock): kept open, never closed, for the reason in the header. */
const strays: number[] = [];

/** `flock(fd, LOCK_EX | LOCK_NB)`, retried on EINTR: 0 when held, else the errno. */
function tryLock(lib: Flock, fd: number): number {
	let r = lib.flock(fd, LOCK_EX | LOCK_NB);
	for (let i = 0; r !== 0 && i < 100 && lib.errno() === EINTR; i++) r = lib.flock(fd, LOCK_EX | LOCK_NB);
	return r === 0 ? 0 : lib.errno();
}

/**
 * Takes the relay's lock for the database at `db`, a `flock` on the directory that holds it, or throws RelayRunningError at once (it never
 * waits). Synchronous. The directory must exist; the database is created (empty, mode 0600) if it does not exist yet. The lock is held
 * until `release()` or until the process ends. Throws RelayLockUnavailableError, having opened nothing, where `flock` cannot be loaded, and
 * RelayDatabaseLinkedError, having released the lock, when the database has more than one hard link. `o.lib` is a seam for tests.
 */
export function holdRelayLock(db: string, o: { lib?: () => Flock } = {}): RelayLock {
	const { dir, path } = locate(db);
	// Defense in depth: a second acquisition in this process is refused before anything is opened.
	let before: string | undefined;
	try {
		before = fileKey(statSync(dir));
	} catch {
		/* checked again on the descriptor */
	}
	if (before && held.has(before)) throw new RelayRunningError(dir);
	const lib = o.lib ? o.lib() : (loaded ??= loadFlock());
	const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
	let key: string, dbKey: string;
	try {
		key = fileKey(fstatSync(fd));
		if (held.has(key)) throw new RelayRunningError(dir);
		const errno = tryLock(lib, fd);
		if (errno === EWOULDBLOCK) throw new RelayRunningError(dir);
		if (errno !== 0) throw new Error(`flock(${dir}) failed with errno ${errno}; refusing to start the relay`);
		try {
			// Under the lock: the database in this directory, created if it is not there yet (that descriptor is never closed: see the header).
			let st;
			try {
				st = statSync(path);
			} catch {
				const created = openSync(path, constants.O_RDONLY | constants.O_CREAT, FILE_MODE);
				strays.push(created);
				st = fstatSync(created);
			}
			if (!st.isFile()) throw new Error(`${path} is not a regular file; refusing to start the relay`);
			if (st.nlink > 1) throw new RelayDatabaseLinkedError(path, st.nlink);
			dbKey = fileKey(st);
		} catch (e) {
			lib.flock(fd, LOCK_UN);
			throw e;
		}
	} catch (e) {
		closeSync(fd);
		throw e;
	}
	held.add(key);
	let released = false;
	const handle = {
		path,
		directory: dir,
		identity: `${key} ${dbKey}`,
		held: () => !released,
		release() {
			if (released) return;
			released = true;
			lib.flock(fd, LOCK_UN);
			closeSync(fd);
			held.delete(key);
		},
	} as RelayLock;
	issued.add(handle);
	return handle;
}

/**
 * TEST ONLY (called by src/testing/lock.ts alone; src/architecture.test.ts checks, and it throws unless the process is a test run: test-env.ts).
 * A handle that is NOT a kernel lock, bound to `db` exactly as a real one is: to its directory's and its own device and inode, or to nothing
 * but an in-memory store for ":memory:". Hundreds of in-process tests cannot all contend for one real `flock`, and several relays over one
 * scratch database (a "restart") must be able to coexist. Everything that checks the handle (isRelayLock, held, lockCovers) treats it as a real one.
 */
export function holdTestRelayLock(db: string): RelayLock {
	requireTestEnv("holdTestRelayLock");
	const memory = db === ":memory:";
	const identity = memory ? MEMORY : identityOf(db);
	let released = false;
	const handle = {
		path: db,
		directory: memory ? "" : locate(db).dir,
		identity,
		held: () => !released,
		release() {
			released = true;
		},
	} as RelayLock;
	issued.add(handle);
	return handle;
}

/** Nothing got the lock within the wait: another open file description holds it. */
export class FlockBusyError extends Error {
	constructor(
		readonly path: string,
		readonly waitedMs: number,
	) {
		super(`${path} is locked by another process (waited ${waitedMs} ms)`);
		this.name = "FlockBusyError";
	}
}

const sleepSync = (ms: number) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Takes an exclusive `flock(2)` on `path`, a directory or a file that is NOT a database (it is opened read-only and closed on release; closing a
 * descriptor to a SQLite file would drop SQLite's own locks, and on macOS a `flock` on a SQLite file conflicts with them: see the header), waits up to
 * `waitMs` for the holder, and throws FlockBusyError if it is still held. Synchronous: it polls `LOCK_NB` every 25 ms rather than blocking the
 * thread in the kernel, so the timeout is real. The kernel owns the lock: it belongs to this open file description and is gone when the holder
 * closes it or dies, however it dies, so nothing is ever broken, aged out or cleaned up, and no one can release another process's lock.
 * Throws RelayLockUnavailableError where `flock` cannot be called. `o.lib` is a seam for tests. Used by the config migration (migrate.ts, on the
 * config directory) and the state move (state-dir.ts, on the state directory: the relay's own lock, so a move into the state directory of a
 * running daemon waits for it and is refused).
 */
export function holdFlock(path: string, o: { waitMs: number; lib?: () => Flock }): { release(): void } {
	const lib = o.lib ? o.lib() : (loaded ??= loadFlock());
	const fd = openSync(path, constants.O_RDONLY);
	const started = Date.now();
	try {
		for (;;) {
			const errno = tryLock(lib, fd);
			if (errno === 0) break;
			if (errno !== EWOULDBLOCK) throw new Error(`flock(${path}) failed with errno ${errno}`);
			const waited = Date.now() - started;
			if (waited >= o.waitMs) throw new FlockBusyError(path, waited);
			sleepSync(Math.min(25, Math.max(1, o.waitMs - waited)));
		}
	} catch (e) {
		closeSync(fd);
		throw e;
	}
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			lib.flock(fd, LOCK_UN);
			closeSync(fd);
		},
	};
}

/** Filesystem types whose POSIX locks do not work reliably across clients. */
const NETWORK_FS =
	/^(nfs\d?|cifs|smb3?|smbfs|afs|afpfs|9p|ncpfs|webdav|ceph|glusterfs|lustre|fuse\.sshfs|fuse\.glusterfs|fuse\.nfs|fuse\.cephfs|fuse\.rclone|fuse\.s3fs|fuse\.davfs|ocfs2|gfs2)$/i;

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
		if (process.platform === "linux")
			return networkFilesystemIn(real, { linux: readFileSync("/proc/self/mountinfo", "utf8") });
		if (process.platform === "darwin")
			return networkFilesystemIn(real, { mac: execFileSync("/sbin/mount", { encoding: "utf8", timeout: 2000 }) });
	} catch {
		/* unknown: say nothing */
	}
	return undefined;
}

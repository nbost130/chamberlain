/** flock(2) through libc: loading it, the exclusive lock on a directory, and whether a path is on a network filesystem. */
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, realpathSync } from "node:fs";
import { tryLock } from "./singleton.ts";

/** flock(2) operations, the same on Linux and macOS (<sys/file.h>). */
export const LOCK_EX = 2,
	LOCK_NB = 4,
	LOCK_UN = 8;
export const EINTR = 4;
/** EWOULDBLOCK, which is EAGAIN on both: 11 on Linux (glibc and musl), 35 on macOS (<sys/errno.h>). */
export const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

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
/** The test seam's library if it has one, else the process's own, loaded once. */
export function flockLib(seam?: () => Flock): Flock {
	if (seam) return seam();
	loaded ??= loadFlock();
	return loaded;
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
	const lib = flockLib(o.lib);
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
		const mountPoint = pre?.split(" ")[4];
		const type = post?.split(" ")[0];
		if (mountPoint !== undefined && type) consider(unescapeMount(mountPoint), type);
	}
	for (const line of (mounts.mac ?? "").split("\n")) {
		// "//user@host/share on /Volumes/share (smbfs, nodev, nosuid)"
		const m = /^.+ on (.+) \(([^,)]+)/.exec(line);
		const [, point, fsType] = m ?? [];
		if (point !== undefined && fsType !== undefined) consider(point, fsType);
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

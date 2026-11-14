/** singleton, continued: see singleton.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { closeSync, linkSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { useCoreSingletonFixtures } from "../testing/core-singleton-fixtures.ts";
import { libcCandidates, loadFlock, networkFilesystemIn, RelayLockUnavailableError } from "./flock.ts";
import { holdRelayLock, RelayDatabaseLinkedError, RelayRunningError } from "./singleton.ts";
import { openStore } from "./sqlite-store.ts";

const { scratch } = useCoreSingletonFixtures();

describe("the relay's lock never conflicts with SQLite's own locks on this platform", () => {
	test("this platform's semantics, probed: a flock on a database SQLite has open conflicts with SQLite's fcntl locks on macOS, not on Linux", () => {
		// On macOS and FreeBSD, flock(2) and fcntl(2) locks share one lock list per file and interact; on Linux they are independent. This is
		// why the relay's lock is on the directory, which SQLite never locks. If this ever fails, the platform's semantics changed: re-read the
		// singleton header before touching the lock.
		const db = `${scratch()}/probe.db`;
		const sql = new Database(db);
		sql.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES (1);");
		sql.query("SELECT a FROM t").all(); // a WAL connection keeps a shared fcntl lock on the database file while it is open
		const lib = loadFlock();
		const fd = openSync(db, "r");
		try {
			const r = lib.flock(fd, 2 | 4);
			if (process.platform === "darwin") {
				expect(r).toBe(-1);
				expect(lib.errno()).toBe(35); // EWOULDBLOCK: SQLite's own lock, in this very process, refuses a flock on its file
			} else {
				expect(r).toBe(0);
				lib.flock(fd, 8);
			}
		} finally {
			sql.close();
			closeSync(fd);
		}
	});

	test("the relay's lock is taken and kept while this process's SQLite connection holds its locks, and SQLite keeps writing under it", () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const store = openStore(db); // as the daemon: the database open through SQLite, in WAL mode, before the lock is taken
		store.state.update<number>("n", (n) => (n ?? 0) + 1);
		const lock = holdRelayLock(db);
		try {
			store.state.update<number>("n", (n) => (n ?? 0) + 1);
			const other = new Database(db);
			other.exec("PRAGMA busy_timeout = 2000; CREATE TABLE probe(a); INSERT INTO probe VALUES (1);");
			other.close();
			expect(store.state.get<number>("n")).toBe(2);
			expect(lock.held()).toBe(true);
			expect(() => holdRelayLock(db)).toThrow(RelayRunningError);
		} finally {
			store.close();
		}
		// With no SQLite connection left in this process, a flock on the database FILE from a fresh open file description is granted while the
		// relay still holds: the relay never locks a file SQLite locks.
		const lib = loadFlock();
		const fd = openSync(db, "r");
		try {
			expect(lib.flock(fd, 2 | 4)).toBe(0);
			lib.flock(fd, 8);
		} finally {
			closeSync(fd);
		}
		expect(lock.held()).toBe(true);
		expect(() => holdRelayLock(db)).toThrow(RelayRunningError);
		lock.release();
	});

	test("a database with another hard link is refused at start, and the refusal lets the directory go", () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		openStore(db).close();
		const other = scratch();
		linkSync(db, `${other}/link.db`);
		expect(() => holdRelayLock(db)).toThrow(RelayDatabaseLinkedError);
		expect(() => holdRelayLock(`${other}/link.db`)).toThrow(RelayDatabaseLinkedError);
		unlinkSync(`${other}/link.db`);
		holdRelayLock(db).release();
	});
});

describe("where flock cannot be loaded, the relay refuses to start: there is no fallback", () => {
	test("an unsupported platform or a C library that cannot be loaded is RelayLockUnavailableError", () => {
		expect(libcCandidates("win32", "x64")).toEqual([]);
		expect(() => loadFlock([], "win32")).toThrow(RelayLockUnavailableError);
		expect(() => loadFlock(["libchamberlain-does-not-exist.so.9"])).toThrow(RelayLockUnavailableError);
	});
	test("holdRelayLock opens nothing and creates nothing when flock is unavailable", () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		expect(() => holdRelayLock(db, { lib: () => loadFlock([], "win32") })).toThrow(RelayLockUnavailableError);
		expect(readdirSync(dir)).toEqual([]);
	});
	test("the libraries and the flock ABI are the documented ones", () => {
		expect(libcCandidates("linux", "x64")[0]).toBe("libc.so.6");
		expect(libcCandidates("darwin", "arm64")).toContain("libSystem.B.dylib");
		const lib = loadFlock();
		const dir = scratch();
		const fd = openSync(`${dir}/f`, "w");
		const fd2 = openSync(`${dir}/f`, "r");
		try {
			expect(lib.flock(fd, 2 | 4)).toBe(0); // LOCK_EX | LOCK_NB
			expect(lib.flock(fd2, 2 | 4)).toBe(-1); // a second open file description in this same process conflicts
			expect(lib.errno()).toBe(process.platform === "darwin" ? 35 : 11); // EWOULDBLOCK
			expect(lib.flock(fd, 8)).toBe(0); // LOCK_UN
			expect(lib.flock(fd2, 2 | 4)).toBe(0);
		} finally {
			closeSync(fd);
			closeSync(fd2);
		}
	});
});

describe("a state directory on a network filesystem is recognised from the mount table", () => {
	const linux = [
		"22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
		"40 22 0:35 / /mnt/share rw,relatime shared:9 - nfs4 server:/export rw,vers=4.2",
		"41 22 0:36 / /mnt/with\\040space rw - cifs //host/share rw",
		"42 40 8:2 / /mnt/share/local rw - ext4 /dev/sdb1 rw",
	].join("\n");
	test("Linux /proc/self/mountinfo: the longest mount point decides, and escaped spaces are read", () => {
		expect(networkFilesystemIn("/home/u/.local/state/chamberlain", { linux })).toBeUndefined();
		expect(networkFilesystemIn("/mnt/share/state", { linux })).toBe("nfs4");
		expect(networkFilesystemIn("/mnt/share/local/state", { linux })).toBeUndefined();
		expect(networkFilesystemIn("/mnt/with space/state", { linux })).toBe("cifs");
		expect(networkFilesystemIn("/mnt/shared/state", { linux })).toBeUndefined();
	});
	test("macOS mount output", () => {
		const mac =
			"/dev/disk3s1 on / (apfs, local, journaled)\n//u@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by u)\nnas:/vol on /Volumes/nfs (nfs, nodev)";
		expect(networkFilesystemIn("/Users/u/state", { mac })).toBeUndefined();
		expect(networkFilesystemIn("/Volumes/share/chamberlain", { mac })).toBe("smbfs");
		expect(networkFilesystemIn("/Volumes/nfs/x", { mac })).toBe("nfs");
	});
});

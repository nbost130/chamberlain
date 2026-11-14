/**
 * The relay's singleton: one holder per STATE DIRECTORY (the directory that holds the database), whatever the environment or the spelling of
 * its path, released by the operating system when the holder dies, and never in the way of SQLite's own locks on the platform it runs on. The
 * scenarios run with real processes (src/testing/hold-relay.ts), because an in-process test cannot tell a lock that belongs to the process
 * from one that belongs to the open file, or a lock on a path from one on the directory.
 *
 * Every holder here is a real process that does what the reproducer did to the old `fcntl` lock (flag `twice`): once it holds
 * the lock, it tries again in the same process and opens and closes other descriptors to the database and its directory. Under POSIX `fcntl` locks that
 * released the holder's lock; under `flock` it must not.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	holdRelayLock,
	libcCandidates,
	loadFlock,
	networkFilesystemIn,
	RelayDatabaseLinkedError,
	RelayLockUnavailableError,
	RelayRunningError,
} from "./singleton.ts";
import { openStore } from "./sqlite-store.ts";

const HOLD = new URL("../testing/hold-relay.ts", import.meta.url).pathname;
const WORKER = new URL("../testing/store-worker.ts", import.meta.url).pathname;
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-singleton-`);
	dirs.push(d);
	return d;
};

type StartOpts = { env?: Record<string, string>; cwd?: string; startAt?: number; flags?: string };
/** A starter process; `env` replaces the inherited XDG_RUNTIME_DIR and TMPDIR. */
function starter(db: string, holdMs: number, o: StartOpts = {}) {
	const p = Bun.spawn([process.execPath, HOLD, db, String(holdMs), String(o.startAt ?? 0), o.flags ?? ""], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: o.cwd,
		env: { ...process.env, ...o.env },
	});
	return {
		p,
		out: () => new Response(p.stdout).text().then((t) => t.trim()),
		first: async () => {
			const r = p.stdout.getReader();
			const { value } = await r.read();
			r.releaseLock();
			return new TextDecoder().decode(value).trim();
		},
	};
}
/** A holder like the daemon: the Store open on the database, and a second local acquisition refused (flags `store,twice`). Waits for "held". */
async function holder(db: string, o: StartOpts = {}) {
	const s = starter(db, 30_000, { flags: "store,twice", ...o });
	const line = await s.first();
	expect(line.split(" ")[0]).toBe("held");
	return { ...s, extra: line.split(" ").slice(1) };
}
const refusedFor = async (db: string, o: StartOpts = {}) => await starter(db, 10, o).out();
const kill = async (h: { p: ReturnType<typeof Bun.spawn> }) => {
	h.p.kill("SIGKILL");
	await h.p.exited;
};

describe("one relay per state directory", () => {
	test("a refused second acquisition in the holder's own process does not release its lock; a child is still refused", async () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const store = openStore(db); // as in the daemon, the database is open through SQLite in the holding process
		const lock = holdRelayLock(db);
		try {
			expect(await refusedFor(db)).toBe("refused");
			expect(() => holdRelayLock(db)).toThrow(RelayRunningError);
			expect(() => holdRelayLock(`${dir}/./chamberlain.db`)).toThrow(RelayRunningError);
			// Other descriptors to the same file, opened and closed in this process, do not release it either.
			closeSync(openSync(db, "r"));
			new Database(db).close();
			expect(await refusedFor(db)).toBe("refused");
			expect(await refusedFor(db, { flags: "store" })).toBe("refused");
		} finally {
			lock.release();
			store.close();
		}
		expect(await refusedFor(db)).toBe("held");
	}, 20_000);

	test("deleting, replacing or renaming paths around the state directory does not let a second relay in", async () => {
		const root = scratch();
		const state = `${root}/state`;
		mkdirSync(state);
		const db = `${state}/chamberlain.db`;
		openStore(db).close();
		const first = await holder(db);
		try {
			expect(await refusedFor(db)).toBe("refused");
			// The old design's sidecar lock file, deleted, then replaced by a fresh one, while the holder lives.
			rmSync(`${db}-relay-lock`, { force: true });
			expect(await refusedFor(db)).toBe("refused");
			writeFileSync(`${db}-relay-lock`, "", { mode: 0o600 });
			expect(await refusedFor(db)).toBe("refused");
			unlinkSync(`${db}-relay-lock`);
			// A hard link to the database in another directory: the lock is on the directory, so a database with another link is refused.
			linkSync(db, `${root}/hardlink.db`);
			expect(await refusedFor(`${root}/hardlink.db`)).toBe("linked");
			expect(await refusedFor(db)).toBe("refused");
			// The state directory renamed under the live holder, then reached as `moved`, `moved/`, through a symlink at the old name, and
			// relative to a working directory.
			renameSync(state, `${root}/moved`);
			symlinkSync(`${root}/moved`, state);
			for (const [p, o] of [
				[`${root}/moved/chamberlain.db`, {}],
				[`${root}/moved//chamberlain.db`, {}],
				[db, {}],
				[`${state}/`.replace(/\/$/, "/./chamberlain.db"), {}],
				["moved/chamberlain.db", { cwd: root }],
				["state/chamberlain.db", { cwd: root }],
			] as [string, StartOpts][]) {
				expect([p, await refusedFor(p, o)]).toEqual([p, "refused"]);
			}
			expect(existsSync(`${root}/moved/chamberlain.db-relay-lock`)).toBe(false);
		} finally {
			await kill(first);
		}
	}, 30_000);

	test("different XDG_RUNTIME_DIR and TMPDIR values on the same state directory: the second is refused", async () => {
		const state = scratch();
		const db = `${state}/chamberlain.db`;
		const a = scratch(),
			b = scratch();
		const first = await holder(db, { env: { XDG_RUNTIME_DIR: a, TMPDIR: a } });
		try {
			expect(await refusedFor(db, { env: { XDG_RUNTIME_DIR: b, TMPDIR: b } })).toBe("refused");
			expect(await refusedFor(db, { env: { XDG_RUNTIME_DIR: `${b}/does/not/exist`, TMPDIR: "/nonexistent" } })).toBe(
				"refused",
			);
			expect(await refusedFor(db, { env: { XDG_RUNTIME_DIR: "", TMPDIR: "" } })).toBe("refused");
		} finally {
			await kill(first);
		}
	}, 20_000);

	test("the state directory spelled `state`, `state/`, `state/./`, through a symlinked directory or a symlinked database: all one lock", async () => {
		const root = scratch();
		const state = `${root}/state`;
		mkdirSync(state);
		openStore(`${state}/chamberlain.db`).close(); // the daemon opens the database first, so it exists whenever the lock is taken
		symlinkSync(state, `${root}/dirlink`);
		symlinkSync(`${state}/chamberlain.db`, `${root}/dblink.db`);
		const first = await holder(`${state}/chamberlain.db`);
		try {
			const spellings: [string, { cwd?: string }][] = [
				[`${state}/chamberlain.db`, {}],
				[`${state}//chamberlain.db`, {}],
				[`${state}/./chamberlain.db`, {}],
				[`${state}/../state/chamberlain.db`, {}],
				[`${root}/dirlink/chamberlain.db`, {}],
				[`${root}/dblink.db`, {}],
				["state/chamberlain.db", { cwd: root }],
				["./state/chamberlain.db", { cwd: root }],
				["chamberlain.db", { cwd: state }],
				["dirlink/chamberlain.db", { cwd: root }],
			];
			for (const [db, o] of spellings) expect([db, await refusedFor(db, o)]).toEqual([db, "refused"]);
		} finally {
			await kill(first);
		}
	}, 30_000);

	test("a very long state path (past any socket path limit) is one lock too, whatever the environment", async () => {
		const root = scratch();
		let state = root;
		while (state.length < 300) {
			state += `/${"d".repeat(60)}`;
		}
		mkdirSync(state, { recursive: true });
		expect(state.length).toBeGreaterThan(256);
		const db = `${state}/chamberlain.db`;
		const first = await holder(db, { env: { XDG_RUNTIME_DIR: `${root}/r1` } });
		try {
			expect(await refusedFor(db, { env: { XDG_RUNTIME_DIR: `${root}/r2` } })).toBe("refused");
			expect(
				await refusedFor(`${state}/`.replace(/\/$/, `/../${"d".repeat(60)}/chamberlain.db`), {
					env: { XDG_RUNTIME_DIR: `${root}/r3` },
				}),
			).toBe("refused");
		} finally {
			await kill(first);
		}
	}, 20_000);

	test("twelve simultaneous starters that keep trying, while the holder keeps retrying in its own process: exactly one ever holds", async () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		openStore(db).close();
		const startAt = Date.now() + 1500;
		// Each starter retries for 2 s after the start; whoever holds keeps the lock for 8 s and retries locally every 20 ms meanwhile.
		const runs = Array.from({ length: 12 }, (_, i) =>
			starter(i % 2 ? `${dir}/./chamberlain.db` : db, 8000, {
				startAt,
				flags: "store,retry=2000",
				env: { XDG_RUNTIME_DIR: `${dir}/r${i}`, TMPDIR: `${dir}/t${i}` },
			}),
		);
		const outs = await Promise.all(runs.map((r) => r.out()));
		expect(outs.sort()).toEqual(["held", ...Array(11).fill("refused")]);
	}, 40_000);

	test("SIGKILL of the holder: the next starter takes the lock at once, and nothing is left beside the database", async () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const first = await holder(db);
		expect(await refusedFor(db)).toBe("refused");
		await kill(first);
		expect(first.p.signalCode).toBe("SIGKILL");
		const t0 = Date.now();
		const next = starter(db, 100);
		expect(await next.out()).toBe("held");
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(readdirSync(dir).filter((f) => !/^chamberlain\.db(-wal|-shm)?$/.test(f))).toEqual([]);
	}, 20_000);

	test("children the holder spawned do not inherit the lock: once the holder is killed, the next starter takes it while they live", async () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const first = await holder(db, { flags: "store,twice,spawn" });
		const kids = first.extra.map(Number);
		pids.push(...kids);
		expect(kids).toHaveLength(2);
		await kill(first);
		for (const pid of kids) expect(() => process.kill(pid, 0)).not.toThrow(); // still alive
		expect(await refusedFor(db)).toBe("held");
	}, 20_000);

	test("while the relay holds the flock, other processes read and commit writes to the same database through SQLite", async () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const first = await holder(db);
		try {
			// The lock is on the state directory: the relay's lock from another process is refused...
			const probe = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { holdRelayLock } from ${JSON.stringify(new URL("./singleton.ts", import.meta.url).pathname)}; try { holdRelayLock(${JSON.stringify(db)}); console.log("held"); } catch (e) { console.log(e.constructor.name); }`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect((await new Response(probe.stdout).text()).trim()).toBe("RelayRunningError");
			// ...and yet SQLite's own (fcntl) locking is untouched: writers commit, in the store's normal busy handling, as the page does.
			const n = 25;
			const workers = [0, 1].map((i) =>
				Bun.spawn([process.execPath, WORKER, db, String(i), String(Date.now() + 300), "writes", String(n)], {
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const outs = await Promise.all(
				workers.map(async (w) => {
					await w.exited;
					return {
						code: w.exitCode,
						out: (await new Response(w.stdout).text()).trim(),
						err: (await new Response(w.stderr).text()).slice(0, 300),
					};
				}),
			);
			expect(outs).toEqual([
				{ code: 0, out: '{"id":"0"}', err: "" },
				{ code: 0, out: '{"id":"1"}', err: "" },
			]);
			const store = openStore(db);
			try {
				expect(store.state.get<number>("counter")).toBe(2 * n);
				expect(store.state.get<number>("held-by-relay")).toBe(1); // the holder wrote through its own Store while holding, too
			} finally {
				store.close();
			}
			expect(await refusedFor(db)).toBe("refused");
		} finally {
			await kill(first);
		}
	}, 30_000);

	test("the lock is on the database's directory (the database is created 0600 if missing, nothing else), and the holder keeps it until it releases", () => {
		const dir = scratch();
		const db = `${dir}/chamberlain.db`;
		const lock = holdRelayLock(db);
		expect(lock.path).toBe(realpathSync(db));
		expect(lock.directory).toBe(realpathSync(dir));
		expect(statSync(db).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["chamberlain.db"]);
		expect(() => holdRelayLock(db)).toThrow(RelayRunningError);
		lock.release();
		lock.release(); // idempotent
		const again = holdRelayLock(db);
		again.release();
	});

	test("two databases are two locks", () => {
		const a = holdRelayLock(`${scratch()}/chamberlain.db`);
		const b = holdRelayLock(`${scratch()}/chamberlain.db`);
		a.release();
		b.release();
	});
});

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

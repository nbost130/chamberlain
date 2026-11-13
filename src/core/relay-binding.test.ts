/**
 * The relay's lock handle is bound to its database. A handle is not just "some lock was taken": it records the device and inode of the file it
 * locked, and `createRelay` refuses it unless that is the file the store opened. A reviewer's probe built a relay over `actual.db` on a lock
 * held on `unrelated.db`, with nothing locking `actual.db`: a second daemon could then have locked it and relayed beside the first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { createEngine } from "./engine.ts";
import { createRelay, type RelayDeps } from "./relay.ts";
import { holdRelayLock, lockCovers, RelayRunningError, type RelayLock } from "./singleton.ts";
import { openStore } from "./sqlite-store.ts";
import type { Store } from "./store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const scratch = () => { const d = mkdtempSync(`${tmpdir()}/chamberlain-binding-`); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const open = (path: string) => { const s = openStore(path); cleanups.push(() => s.close()); return s; };
const hold = (path: string) => { const l = holdRelayLock(path); cleanups.push(() => l.release()); return l; };
const base = (store: Store, lock: RelayLock): RelayDeps => ({ store, lock, wake: { ready: () => true, send: async () => ({ ok: true }) }, gate: () => "idle", log: () => {}, alarm: () => {} });

describe("a relay lock is the lock on the relay's own database", () => {
	test("a handle for another database is refused, with the real lock held and nothing locking the store's own file", () => {
		const dir = scratch();
		const store = open(`${dir}/actual.db`);
		const unrelated = hold(`${dir}/unrelated.db`);
		expect(unrelated.held()).toBe(true);
		expect(() => createRelay(base(store, unrelated))).toThrow("not on this store's database");
		// The store's own file was never locked by that handle: a daemon on it can still take the real lock.
		hold(store.path).release();
	});

	test("the handle for the store's own file is accepted, and so is the same file by another path", () => {
		const dir = scratch();
		const store = open(`${dir}/chamberlain.db`);
		symlinkSync(store.path, `${dir}/alias.db`);
		const lock = hold(`${dir}/alias.db`);
		expect(lock.identity).toBe(`${statSync(store.path).dev}:${statSync(store.path).ino}`);
		expect(() => createRelay(base(store, lock))).not.toThrow();
		expect(() => holdRelayLock(store.path)).toThrow(RelayRunningError);
	});

	test("a handle for a database that has been replaced by another file at the same path is refused", () => {
		const dir = scratch();
		const store = open(`${dir}/chamberlain.db`);
		const lock = hold(store.path);
		expect(lockCovers(lock, store.path)).toBe(true);
		renameSync(store.path, `${dir}/moved.db`);
		open(`${dir}/chamberlain.db`);
		expect(lockCovers(lock, `${dir}/chamberlain.db`)).toBe(false);
		expect(lockCovers(lock, `${dir}/no-such.db`)).toBe(false);
	});

	test("createEngine refuses a handle for another database, because it builds its relay over the store", () => {
		const dir = scratch();
		const store = open(`${dir}/actual.db`);
		const unrelated = hold(`${dir}/unrelated.db`);
		const root = scratch();
		const adapter = { id: "fake", capabilities: [], watch: () => new Promise<void>(() => {}), wake: { ready: () => true, send: async () => ({ ok: true }) }, isBusy: () => "idle", post: async () => ({ ok: true }), serverLine: () => "" };
		expect(() => createEngine({ conf: root, lock: unrelated, store, servers: [{ server: { name: "fake", adapter: "fake" }, adapter }], housekeeping: false, log: () => {} } as unknown as Parameters<typeof createEngine>[0])).toThrow("not on this store's database");
	});

	test("the test handle is bound the same way: to the store it was made for, and an in-memory store only takes the in-memory one", () => {
		const dir = scratch();
		const a = open(`${dir}/a.db`);
		const b = open(`${dir}/b.db`);
		const mem = memStore();
		expect(() => createRelay(base(a, testRelayLock(a)))).not.toThrow();
		expect(() => createRelay(base(b, testRelayLock(a)))).toThrow("not on this store's database");
		expect(() => createRelay(base(a, testRelayLock()))).toThrow("not on this store's database");
		expect(() => createRelay(base(mem, testRelayLock()))).not.toThrow();
		expect(() => createRelay(base(mem, testRelayLock(a)))).toThrow("not on this store's database");
		// A real handle never covers an in-memory store.
		expect(() => createRelay(base(mem, hold(`${dir}/c.db`)))).toThrow("not on this store's database");
	});
});

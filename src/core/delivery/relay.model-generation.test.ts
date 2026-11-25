import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import { createOutbox, type WakeTransport } from "./deliver.ts";
import { createRelay } from "./relay.ts";

test("a generation change during model preparation holds the wake without an attempt", async () => {
	const store = memStore();
	const lock = testRelayLock(store);
	store.steward.insertGen({ gen: 1, thread: "old", wakeRef: "old-wake", createdAt: 1 });
	const prepared: (string | undefined)[] = [];
	let sent = 0;
	const relay = createRelay({
		store,
		lock,
		gate: () => "idle",
		log: () => {},
		alarm: () => {},
		wake: {
			ready: () => true,
			prepare: async (thread) => {
				prepared.push(thread);
				store.steward.insertGen({ gen: 2, thread: "new", wakeRef: "new-wake", createdAt: 2 });
				return { ok: true };
			},
			send: async () => {
				sent++;
				return { ok: true };
			},
		},
	});
	try {
		createOutbox({ store, log: () => {} }).deliver("pending", "one", { kind: "failed" });
		await relay.pass();
		expect(prepared).toEqual(["old"]);
		expect(sent).toBe(0);
		expect(store.wakes.find("one")).toMatchObject({ status: "pending", attempts: 0 });
	} finally {
		lock.release();
		store.close();
	}
});

test("compaction binds preparation and target to the committed generation, and holds a concurrent switch", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-generation-`);
	mkdirSync(`${conf}/secrets`, { mode: 0o700 });
	writeFileSync(`${conf}/secrets/compact`, "https://example.test/compact", { mode: 0o600 });
	const store = memStore();
	const lock = testRelayLock(store);
	store.steward.insertGen({ gen: 1, thread: "committed", wakeRef: "wake", compactRef: "compact", createdAt: 1 });
	const prepared: (string | undefined)[] = [];
	const targets: (string | undefined)[] = [];
	const compact: WakeTransport = {
		ready: () => true,
		prepare: async (thread) => {
			prepared.push(thread);
			return { ok: true };
		},
		send: async (_id, _text, opts) => {
			targets.push(opts?.target);
			return { ok: true };
		},
	};
	const relay = createRelay({
		store,
		lock,
		conf,
		compact,
		wake: compact,
		gate: () => "idle",
		log: () => {},
		alarm: () => {},
	});
	try {
		expect((await relay.compact("first")).ok).toBe(true);
		expect(prepared).toEqual(["committed"]);
		expect(targets).toEqual(["https://example.test/compact"]);
		compact.prepare = async () => {
			store.steward.insertGen({ gen: 2, thread: "next", wakeRef: "wake", compactRef: "compact", createdAt: 2 });
			return { ok: true };
		};
		expect(await relay.compact("second")).toMatchObject({
			ok: false,
			error: "Steward changed during model preparation",
		});
		expect(targets).toHaveLength(1);
	} finally {
		lock.release();
		store.close();
		rmSync(conf, { recursive: true, force: true });
	}
});

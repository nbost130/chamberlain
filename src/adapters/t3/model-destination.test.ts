import { afterEach, expect, test } from "bun:test";
import { createOutbox } from "../../core/delivery/deliver.ts";
import { createRelay } from "../../core/delivery/relay.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { modelServer } from "../../testing/model-server.ts";
import { memStore } from "../../testing/store.ts";
import { configureThread } from "./model.ts";
import { modelWake } from "./model-wake.ts";
import { webhookWake } from "./wake.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

test("wrong thread, disabled tasks, unbound tasks, policy blocks and signed hooks refuse preparation", async () => {
	for (const change of [
		{ threadId: "another-thread" },
		{ threadId: null },
		{ enabled: false },
		{ blockedByPolicy: "disabled" },
		{ threadMode: "new_thread" },
		{ schedule: { type: "interval" } },
		{ webhook: { url: null, path: "/wake", hasSecret: true } },
	]) {
		const s = setup();
		const url = `${s.config.servers[0]!.origin}/wake`;
		Object.assign(s.bindWake(url, "steward-id"), change);
		await expect(configureThread(s.conf, "steward", undefined, url)).rejects.toThrow("webhook");
		const wake = modelWake(
			webhookWake(() => url),
			s.conf,
			"steward",
		);
		expect(await wake.prepare!(undefined, url)).toMatchObject({ ok: false, reason: "config" });
		expect(s.selection().instanceId).toBe("old");
		expect(s.posts).toHaveLength(0);
	}
});

test("authenticated local paths and advertised relay URLs bind to the configured thread", async () => {
	const s = setup();
	const task = s.bindWake("https://relay.example.test/hooks/test-capability", "steward-id");
	await configureThread(s.conf, "steward", undefined, task.webhook.url);
	await configureThread(s.conf, "steward", undefined, `${s.config.servers[0]!.origin}/wake`);
	await expect(configureThread(s.conf, "steward", undefined, "https://elsewhere.example.test/wake")).rejects.toThrow(
		"webhook",
	);
});

test("Steward and Desk retain mismatched wakes then deliver once after the operator repairs the binding", async () => {
	for (const role of ["steward", "desk"] as const) {
		const s = setup();
		const url = `${s.config.servers[0]!.origin}/wake`;
		const task = s.bindWake(url, "wrong-thread");
		const store = memStore();
		const lock = testRelayLock(store);
		let now = 1000;
		const wake = modelWake(
			webhookWake(() => url),
			s.conf,
			role,
			{ hooked: () => true },
		);
		const relay = createRelay({
			store,
			lock,
			wake,
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => now,
			retryAfterMs: () => 1,
			...(role === "desk" ? { receivers: { desk: { wake, gate: () => "idle" as const } } } : {}),
		});
		try {
			createOutbox({ store, log: () => {} }).deliver("pending test content", "one", {
				kind: "failed",
				...(role === "desk" ? { receiver: "desk" } : {}),
			});
			await relay.pass();
			expect(store.wakes.find("one")).toMatchObject({ status: "pending", attempts: 0 });
			expect(s.posts).toHaveLength(0);
			task.threadId = s.config.threads[role];
			now += 1000;
			await relay.pass();
			await relay.pass();
			expect(store.wakes.find("one")).toMatchObject({ status: "delivered", attempts: 1 });
			expect(s.posts).toHaveLength(1);
		} finally {
			lock.release();
			store.close();
		}
	}
});

test("compaction refuses a mismatched destination before invalidating rights or sending", async () => {
	const s = setup();
	const url = `${s.config.servers[0]!.origin}/wake`;
	const task = s.bindWake(url, "wrong-thread");
	const store = memStore();
	const lock = testRelayLock(store);
	const events: string[] = [];
	const compact = modelWake(
		webhookWake(() => url),
		s.conf,
		"steward",
	);
	const relay = createRelay({
		store,
		lock,
		wake: compact,
		compact,
		gate: () => "idle",
		log: (e) => events.push(e),
		alarm: () => {},
	});
	try {
		expect((await relay.compact("first")).ok).toBe(false);
		expect(events).not.toContain("rights-invalidated");
		expect(s.posts).toHaveLength(0);
		task.threadId = "steward-id";
		expect((await relay.compact("second")).ok).toBe(true);
		expect(s.posts).toHaveLength(1);
	} finally {
		lock.release();
		store.close();
	}
});

test("URL changes during preparation cannot redirect a wake's content", async () => {
	const s = setup();
	const other = setup();
	let url = `${s.config.servers[0]!.origin}/wake`;
	s.bindWake(url, "steward-id");
	const wake = modelWake(
		webhookWake(() => url),
		s.conf,
		"steward",
	);
	const prepare = wake.prepare!;
	wake.prepare = async (thread, target) => {
		const ok = await prepare(thread, target);
		url = `${other.config.servers[0]!.origin}/wake`;
		return ok;
	};
	const store = memStore();
	const lock = testRelayLock(store);
	const relay = createRelay({ store, lock, wake, gate: () => "idle", log: () => {}, alarm: () => {} });
	try {
		createOutbox({ store, log: () => {} }).deliver("private test content", "one", { kind: "failed" });
		await relay.pass();
		expect(s.posts).toHaveLength(1);
		expect(other.posts).toHaveLength(0);
		expect(store.wakes.find("one")?.status).toBe("delivered");
	} finally {
		lock.release();
		store.close();
	}
});
const setup = () => {
	const s = modelServer();
	servers.push(s);
	return s;
};

test("a webhook on another server cannot send to an identically named thread", async () => {
	const a = setup();
	const b = setup();
	const url = `${b.config.servers[0]!.origin}/wake`;
	b.bindWake(url, "steward-id");
	await expect(configureThread(a.conf, "steward", "steward-id", url)).rejects.toThrow("webhook");
	expect(a.requests.some((r) => r.payload.type === "thread.model-selection.set")).toBe(false);
});

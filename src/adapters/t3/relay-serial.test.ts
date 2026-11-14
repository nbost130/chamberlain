/**
 * One POST at a time: the relay sends every request to the Steward's webhook, a wake or a compaction, through one serial queue, so the
 * webhook never has two requests in flight. A probe once saw an ordinary wake and a compaction in flight at once (a peak of 2),
 * because `tick()` starts the relay's pass and the Steward check together and the compaction was sent outside the pass's chain.
 *
 * The receiver here is a real HTTP server and the transport is the real `webhookWake`, so what is measured is what the webhook would see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngine } from "../../core/engine.ts";
import { createRelay } from "../../core/relay.ts";
import { holdRelayLock } from "../../core/singleton.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { noAlert } from "../../testing/alert.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import { webhookWake } from "./wake.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

/** A webhook that answers each request after `holdMs` and records how many were in flight at once. */
function receiver(holdMs: number) {
	const seen: string[] = [];
	let active = 0;
	let peak = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { deliveryId: string };
			seen.push(body.deliveryId);
			peak = Math.max(peak, ++active);
			await Bun.sleep(holdMs);
			active--;
			return new Response("ok");
		},
	});
	cleanups.push(() => {
		server.stop(true);
	});
	return { url: `http://127.0.0.1:${server.port}`, seen, peak: () => peak };
}

describe("the relay never has two POSTs in flight", () => {
	test("wakes and compactions mixed over a real webhook peak at one request at a time, and all of them are sent", async () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-serial-`);
		const store = openStore(`${dir}/chamberlain.db`);
		const lock = holdRelayLock(store.path);
		cleanups.push(() => {
			lock.release();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const hook = receiver(40);
		const wake = webhookWake(() => hook.url);
		const relay = createRelay({ store, lock, wake, compact: wake, gate: () => "idle", log: () => {}, alarm: () => {} });
		for (const id of ["w1", "w2", "w3"]) store.wakes.enqueue({ deliveryId: id, message: "x", queuedAt: 0 });

		// A pass is sending the first wake when two compactions arrive, and then a second pass is asked for while all of that is in progress.
		const first = relay.pass();
		await Bun.sleep(10);
		const compactions = [relay.compact("c1"), relay.compact("c2")];
		const second = relay.pass();
		const results = await Promise.all([first, second, ...compactions]);

		expect(hook.peak()).toBe(1);
		expect([...hook.seen].sort()).toEqual(["c1", "c2", "w1", "w2", "w3"]);
		expect(results.slice(2)).toMatchObject([{ ok: true }, { ok: true }]);
		expect(store.wakes.rows().length).toBe(0);
	});

	test("a compaction that arrives while a wake is in flight waits for it, and a wake queued behind a compaction waits too", async () => {
		const store = memStore();
		const lock = testRelayLock();
		let active = 0;
		let peak = 0;
		const order: string[] = [];
		const slow = (tag: string) => async (id: string) => {
			order.push(`${tag}:${id}:start`);
			peak = Math.max(peak, ++active);
			await Bun.sleep(25);
			active--;
			order.push(`${tag}:${id}:end`);
			return { ok: true, status: 202 };
		};
		const relay = createRelay({
			store,
			lock,
			wake: { ready: () => true, send: slow("wake") },
			compact: { ready: () => true, send: slow("compact") },
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
		});
		store.wakes.enqueue({ deliveryId: "w1", message: "x", queuedAt: 0 });
		const p = relay.pass();
		await Bun.sleep(5);
		const c = relay.compact("c1");
		await Promise.all([p, c]);
		expect(peak).toBe(1);
		// The compaction started only after the wake in flight had ended.
		expect(order.indexOf("compact:c1:start")).toBeGreaterThan(order.indexOf("wake:w1:end"));
	});

	test("a compaction that fails does not stall the queue behind it", async () => {
		const store = memStore();
		let first = true;
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			wake: { ready: () => true, send: async () => ({ ok: true, status: 202 }) },
			compact: {
				ready: () => true,
				send: async () => {
					if (first) {
						first = false;
						throw new Error("socket closed");
					}
					return { ok: true, status: 202 };
				},
			},
		});
		await expect(relay.compact("c1")).rejects.toThrow("socket closed");
		await expect(relay.compact("c2")).resolves.toMatchObject({ ok: true });
		store.wakes.enqueue({ deliveryId: "w1", message: "x", queuedAt: 0 });
		expect(await relay.pass()).toEqual(["w1"]);
	});

	test("an engine tick that starts a wake and a compaction together sends them one after the other", async () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-serial-engine-`);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "The Steward may merge green PRs. Everything else, ask.", {
			mode: 0o600,
		});
		writeFileSync(`${conf}/steward-thread`, "steward-1", { mode: 0o600 });
		const store = memStore();
		const fake = createFakeAdapter();
		let active = 0;
		let peak = 0;
		const slowly =
			<A extends unknown[]>(send: (...a: A) => Promise<{ ok: boolean; status?: number }>) =>
			async (...a: A) => {
				peak = Math.max(peak, ++active);
				await Bun.sleep(30);
				try {
					return await send(...a);
				} finally {
					active--;
				}
			};
		fake.wake.send = slowly(fake.wake.send);
		fake.compact!.send = slowly(fake.compact!.send);
		fake.probe = { readable: true, contextTokens: 5000 };
		const engine = createEngine({
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			compactAt: 1000,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: () => {},
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0 },
		});
		cleanups.push(async () => {
			await engine.stop();
			rmSync(root, { recursive: true, force: true });
		});
		// One wake is waiting when the tick runs, and the Steward's context is past the limit.
		engine.outbox.deliver("hello", "w1");
		await engine.tick();
		expect(fake.compactions).toHaveLength(1);
		expect(fake.wakes.map((w) => w.deliveryId)).toEqual(["w1"]);
		expect(peak).toBe(1);
	});
});

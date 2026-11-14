/**
 * The synthetic-wake tool is a producer: it inserts an outbox row and never talks to the webhook. It once POSTed directly, so
 * that with the relay holding the lock and a POST outstanding, two tool runs made three concurrent requests. These tests run the real tool
 * as real processes against a real relay (a real `flock`, the real T3 transport) and a webhook that records how many requests are in flight.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRelay } from "../../core/relay.ts";
import { holdRelayLock } from "../../core/singleton.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { dbPath } from "../../core/store.ts";
import { webhookWake } from "./wake.ts";

const TOOL = new URL("./synthetic-wake.ts", import.meta.url).pathname;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) {
		try {
			c();
		} catch {
			/* best effort */
		}
	}
});

/** A webhook that counts requests in flight and holds each one until `release()`. */
function webhook(o: { hold: boolean }) {
	const seen = { active: 0, peak: 0, ids: [] as string[] };
	let open = !o.hold;
	let gate!: () => void;
	let waiting = new Promise<void>((r) => (gate = r));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { deliveryId: string };
			seen.ids.push(body.deliveryId);
			seen.peak = Math.max(seen.peak, ++seen.active);
			if (!open) await waiting;
			seen.active--;
			return new Response("ok");
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		url: `http://127.0.0.1:${server.port}`,
		seen,
		release: () => {
			open = true;
			gate();
			waiting = Promise.resolve();
		},
	};
}

/** A config and a state directory the tool can run against, with `url` as every webhook file. */
function world(url: string) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-synthetic-`);
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const conf = `${root}/conf`,
		state = `${root}/state`;
	mkdirSync(conf, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	const put = (name: string, body: string) => writeFileSync(`${conf}/${name}`, body, { mode: 0o600 });
	put(
		"servers.json",
		JSON.stringify({
			schemaVersion: 2,
			servers: [{ name: "fake", adapter: "t3", origin: "http://127.0.0.1:12345", tokenFile: "read-token" }],
		}),
	);
	put("decision-rights.md", "The Steward may merge green PRs. Everything else, ask.");
	for (const f of ["wake-url", "wake-url.steward"]) put(f, url);
	const run = (thread: string) =>
		Bun.spawn([process.execPath, TOOL, "fake", thread, "Fixture thread", "Waiting on a decision"], {
			env: { ...process.env, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state },
			stdout: "pipe",
			stderr: "pipe",
		});
	return { conf, state, run };
}
const text = (s: ReadableStream) => new Response(s).text();

describe("synthetic-wake only inserts an outbox row", () => {
	test("one run queues one pending row and sends nothing, with no daemon running", async () => {
		const hook = webhook({ hold: false });
		const w = world(hook.url);
		const p = w.run("thread-a");
		const [code, out, err] = [await p.exited, await text(p.stdout), await text(p.stderr)];
		expect(err).toBe("");
		expect(code).toBe(0);
		expect(out).toContain("queued: synthetic:thread-a:");
		await Bun.sleep(200);
		expect(hook.seen.ids).toEqual([]);
		const store = openStore(dbPath(w.state));
		cleanups.push(() => store.close());
		const rows = store.wakes.rows("pending");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.deliveryId).toStartWith("synthetic:thread-a:");
		expect(rows[0]!.kind).toBe("synthetic");
		expect(rows[0]!.attempts).toBe(0);
		expect(rows[0]!.message).toContain('[chamberlain] needs_input: thread "Fixture thread" is waiting');
		expect(rows[0]!.message).toContain("Everything else, ask.");
	});

	test("with the relay holding the lock and a POST outstanding, two tool runs add no request; the webhook never sees two at once", async () => {
		const hook = webhook({ hold: true });
		const w = world(hook.url);
		const store = openStore(dbPath(w.state));
		const lock = holdRelayLock(store.path);
		cleanups.push(() => {
			lock.release();
			store.close();
		});
		store.wakes.enqueue({ deliveryId: "ordinary", message: "an ordinary wake", queuedAt: Date.now() });
		const relay = createRelay({
			store,
			lock,
			wake: webhookWake(() => hook.url),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			retryAfterMs: () => 0,
		});
		const first = relay.pass();
		for (let i = 0; i < 200 && hook.seen.ids.length < 1; i++) await Bun.sleep(10);
		expect(hook.seen.ids).toEqual(["ordinary"]); // the relay's POST is outstanding

		const children = [w.run("thread-1"), w.run("thread-2")];
		const exited = await Promise.race([
			Promise.all(children.map((c) => c.exited)),
			Bun.sleep(8000).then(() => "the tool runs did not finish: they are waiting on the webhook"),
		]);
		expect(exited).toEqual([0, 0]);
		expect(hook.seen.ids).toEqual(["ordinary"]); // neither run POSTed
		expect(hook.seen.peak).toBe(1);

		hook.release();
		await first;
		for (let i = 0; i < 100 && store.wakes.rows("pending").length > 0; i++) await relay.pass();
		const sent = hook.seen.ids;
		expect(sent).toHaveLength(3);
		expect(sent[0]).toBe("ordinary");
		expect(new Set(sent).size).toBe(3); // each id exactly once
		expect(sent.slice(1).every((id) => id.startsWith("synthetic:thread-"))).toBe(true);
		expect(hook.seen.peak).toBe(1); // the relay sent one at a time, so never two requests together
		expect(
			store.wakes
				.rows("delivered")
				.map((r) => r.deliveryId)
				.sort(),
		).toEqual([...sent].sort());
	});
});

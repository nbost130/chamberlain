/** alert-desk-lane, continued: see alert-desk-lane.test.ts for the overview. */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import { row } from "../../testing/core-alert-desk-lane-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import type { Gate } from "../decide/hold.ts";
import type { WakeTransport } from "../delivery/deliver.ts";
import { createEngine } from "../engine/engine.ts";

describe("the engine drains the inbox into the desk", () => {
	const dirs: string[] = [];
	const engines: { stop: () => Promise<void> }[] = [];
	const saved = process.env.ALERT_DESK_INBOX;
	afterEach(async () => {
		for (const e of engines.splice(0)) await e.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		if (saved === undefined) delete process.env.ALERT_DESK_INBOX;
		else process.env.ALERT_DESK_INBOX = saved;
	});
	function rig(
		caps?: Parameters<typeof createFakeAdapter>[0],
		desk: Record<string, unknown> = { startAt: "beginning" },
	) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-desk-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "ask", { mode: 0o600 });
		writeFileSync(
			`${conf}/alert-desk.json`,
			JSON.stringify({ morningHour: 7, timezone: "America/New_York", ...desk }),
			{ mode: 0o600 },
		);
		process.env.ALERT_DESK_INBOX = `${root}/inbox.jsonl`;
		const store = memStore();
		const logged: { event: string; [k: string]: unknown }[] = [];
		const fake = createFakeAdapter(caps);
		const engine = createEngine({
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: true,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: (event, data) => logged.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => Date.parse("2026-11-13T11:00:00Z"), rightsInline: true },
		});
		engines.push(engine);
		void engine.start();
		return { root, fake, engine, store, logged };
	}
	const alert = (family: string) =>
		`${JSON.stringify({ v: 1, source: "monitor", family, title: `${family} down`, body: "b", ts: new Date().toISOString(), severity: "critical" })}\n`;

	test("an inbox line reaches the desk transport, as a wake the Steward's transport never sees", async () => {
		const r = rig();
		appendFileSync(`${r.root}/inbox.jsonl`, alert("monitor:disk"));
		await r.engine.tick();
		const end = Date.now() + 3000;
		while (r.fake.deskWakes.length === 0 && Date.now() < end) await Bun.sleep(10);
		expect(r.fake.deskWakes).toHaveLength(1);
		expect(r.fake.deskWakes[0]!.message).toContain("CRITICAL alert family monitor:disk");
		expect(r.fake.deskWakes[0]!.message).toContain("delivery id: desk:");
		expect(r.fake.wakes).toEqual([]);
	});
	test('a first start with the default startAt "end" skips what the inbox already holds, logs it, and wakes on what comes after', async () => {
		const r = rig(undefined, {});
		appendFileSync(`${r.root}/inbox.jsonl`, alert("monitor:old-1") + alert("monitor:old-2"));
		const size = statSync(`${r.root}/inbox.jsonl`).size;
		await r.engine.tick();
		await Bun.sleep(50);
		expect(r.fake.deskWakes).toEqual([]);
		expect(r.logged.filter((l) => l.event === "alert-desk-start")).toEqual([
			{ event: "alert-desk-start", startAt: "end", inbox: `${r.root}/inbox.jsonl`, offset: size, skippedBytes: size },
		]);
		appendFileSync(`${r.root}/inbox.jsonl`, alert("monitor:new"));
		await r.engine.tick();
		const end = Date.now() + 3000;
		while (r.fake.deskWakes.length === 0 && Date.now() < end) await Bun.sleep(10);
		expect(r.fake.deskWakes).toHaveLength(1);
		expect(r.fake.deskWakes[0]!.message).toContain("monitor:new");
		expect(r.logged.filter((l) => l.event === "alert-desk-start")).toHaveLength(1);
	});
	test("a backend without the alertDesk capability never reads the inbox", async () => {
		const r = rig({
			capabilities: [
				"answer",
				"listWaiting",
				"setTitle",
				"transcriptPath",
				"inspect",
				"send",
				"stewardProbe",
				"compact",
			],
		});
		appendFileSync(`${r.root}/inbox.jsonl`, alert("monitor:disk"));
		await r.engine.tick();
		await Bun.sleep(50);
		expect(r.fake.deskWakes).toEqual([]);
		expect(r.store.state.get("alert-desk-inbox")).toBeUndefined();
	});
	test("a desk transport with nowhere to send reads nothing, so nothing is lost", async () => {
		const r = rig();
		r.fake.setDeskReady(false);
		appendFileSync(`${r.root}/inbox.jsonl`, alert("monitor:disk"));
		await r.engine.tick();
		expect(r.store.state.get("alert-desk-inbox")).toBeUndefined();
		r.fake.setDeskReady(true);
		await r.engine.tick();
		const end = Date.now() + 3000;
		while (r.fake.deskWakes.length === 0 && Date.now() < end) await Bun.sleep(10);
		expect(r.fake.deskWakes).toHaveLength(1);
	});
});

describe("one relay, one serial queue, for every receiver", () => {
	test("simultaneous Steward and desk wakes are POSTed strictly one at a time, each through its own transport", async () => {
		const store = memStore();
		let inFlight = 0,
			maxInFlight = 0;
		const order: string[] = [];
		const slow = (who: string): WakeTransport => ({
			ready: () => true,
			send: async (deliveryId) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				order.push(`${who}:${deliveryId}`);
				await Bun.sleep(25);
				inFlight--;
				return { ok: true, status: 202 };
			},
		});
		const fake = createFakeAdapter();
		const adapter = { ...fake, wake: slow("steward"), alertDesk: { wake: slow("desk"), isBusy: () => "idle" as Gate } };
		const root = mkdtempSync(`${tmpdir()}/chamberlain-one-relay-`);
		mkdirSync(`${root}/conf`, { recursive: true, mode: 0o700 });
		const engine = createEngine({
			conf: `${root}/conf`,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter }],
			log: () => {},
			timing: { tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, rightsInline: true },
		});
		for (let i = 0; i < 3; i++) {
			store.wakes.enqueue(row(`s${i}`, { kind: "needs_input" }));
			store.wakes.enqueue(row(`d${i}`, { kind: "alert_desk", receiver: "desk" }));
		}
		await Promise.all([engine.tick(), engine.tick(), engine.relay.pass()]);
		await engine.stop();
		rmSync(root, { recursive: true, force: true });
		expect(maxInFlight).toBe(1);
		expect(order.filter((x) => x.startsWith("steward:"))).toEqual(["steward:s0", "steward:s1", "steward:s2"]);
		expect(order.filter((x) => x.startsWith("desk:"))).toEqual(["desk:d0", "desk:d1", "desk:d2"]);
		expect(store.wakes.rows("pending")).toEqual([]);
	});
});

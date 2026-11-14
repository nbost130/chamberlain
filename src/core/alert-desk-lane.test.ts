/**
 * The desk as a second wake receiver of the ONE relay: rows and held wakes are kept per receiver, each row goes to its receiver's transport
 * through the one serial queue, and the desk's gate holds only the desk's wakes. Then the engine, against the fake adapter, drains a real inbox file into the desk transport and never into the Steward's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WakeTransport } from "./deliver.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { noAlert } from "../testing/alert.ts";
import { testRelayLock } from "../testing/lock.ts";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { selfCommand } from "./config.ts";
import { openStore } from "./sqlite-store.ts";
import { createEngine } from "./engine.ts";
import { createRelay } from "./relay.ts";
import { runWakesCli } from "./wakes-cli.ts";
import type { Gate } from "./hold.ts";

const transport = () => {
	const sent: { deliveryId: string; message: string }[] = [];
	const t: WakeTransport = {
		ready: () => true,
		send: async (deliveryId, message) => {
			sent.push({ deliveryId, message });
			return { ok: true, status: 202 };
		},
	};
	return { t, sent };
};
const row = (deliveryId: string, over: Record<string, unknown> = {}) => ({
	deliveryId,
	message: `m ${deliveryId}`,
	queuedAt: Date.now(),
	...over,
});

describe("wakes are kept per receiver", () => {
	test("held and rows read by lane: null is the Steward's, a name is that receiver's, nothing is all of them", () => {
		const s = memStore();
		s.wakes.hold(row("a", { kind: "sweep" }));
		s.wakes.hold(row("b", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.enqueue(row("c", { kind: "needs_input" }));
		s.wakes.enqueue(row("d", { kind: "alert_desk", receiver: "desk" }));
		expect(s.wakes.held(null).map((h) => h.deliveryId)).toEqual(["a"]);
		expect(s.wakes.held("desk").map((h) => h.deliveryId)).toEqual(["b"]);
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["a", "b"]);
		expect(s.wakes.rows("pending", null).map((r) => r.deliveryId)).toEqual(["c"]);
		expect(s.wakes.rows("pending", "desk").map((r) => [r.deliveryId, r.receiver])).toEqual([["d", "desk"]]);
		expect(s.wakes.rows().map((r) => r.deliveryId)).toEqual(["c", "d"]);
	});
	test("a composition takes one receiver's held wakes only", () => {
		const s = memStore();
		s.wakes.hold(row("a", { kind: "sweep" }));
		s.wakes.hold(row("b", { kind: "alert_desk", receiver: "desk" }));
		const composed = s.wakes.compose(
			Date.now(),
			(held) => ({
				deliveryId: "row1",
				message: "x",
				folded: 0,
				members: held.map((h) => h.deliveryId),
				kind: "alert_desk",
				receiver: "desk",
			}),
			"desk",
		);
		expect(composed).toMatchObject({ deliveryId: "row1", receiver: "desk" });
		expect(composed!.members.map((m) => m.deliveryId)).toEqual(["b"]);
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["a"]);
	});
	test("a row's receiver is frozen with it, like its text (the database refuses a change)", () => {
		const path = `${mkdtempSync(`${tmpdir()}/chamberlain-lane-`)}/c.db`;
		const s = openStore(path);
		s.wakes.enqueue(row("d", { receiver: "desk" }));
		const raw = new Database(path);
		expect(() => raw.run("UPDATE outbox SET receiver = NULL WHERE delivery_id = 'd'")).toThrow("immutable");
		raw.close();
		expect(s.wakes.find("d")?.receiver).toBe("desk");
		s.close();
	});
});

describe("one relay, two receivers, one store", () => {
	const both = (
		s: ReturnType<typeof memStore>,
		steward: WakeTransport,
		desk: WakeTransport,
		o: { deskGate?: () => Gate; alarm?: (k: string) => void } = {},
	) =>
		testRelay(s, steward, {
			receivers: { desk: { wake: desk, gate: o.deskGate ?? (() => "idle") } },
			...(o.alarm ? { alarm: o.alarm } : {}),
		});
	test("each row goes to its own receiver's transport, by the row's receiver column", async () => {
		const s = memStore();
		const steward = transport(),
			desk = transport();
		s.wakes.enqueue(row("steward-wake", { kind: "needs_input" }));
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		await both(s, steward.t, desk.t).drain();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["steward-wake"]);
		expect(desk.sent.map((x) => x.deliveryId)).toEqual(["desk-wake"]);
	});
	test("a row for a receiver the relay has no transport for is never sent to the Steward's webhook", async () => {
		const s = memStore();
		const steward = transport();
		const logs: string[] = [];
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		const { relay } = testRelay(s, steward.t, { log: (e) => logs.push(e) });
		await relay.pass();
		await relay.pass();
		expect(steward.sent).toEqual([]);
		expect(s.wakes.rows("pending", "desk")).toHaveLength(1);
		expect(logs.filter((e) => e === "deliver-no-receiver")).toHaveLength(1);
	});
	test("rows for a receiver removed from config raise an alarm naming it and the count, every audit; they are kept, listed and cancellable", async () => {
		const s = memStore();
		const steward = transport();
		const alarms: { key: string; title: string; summary: string }[] = [];
		const logs: { e: string; data?: Record<string, unknown> }[] = [];
		s.wakes.enqueue(row("desk-1", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.enqueue(row("desk-2", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.hold(row("desk-held", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.enqueue(row("steward-wake", { kind: "needs_input" }));
		// The desk was removed from config: this relay has the Steward's lane only.
		const { relay } = testRelay(s, steward.t, {
			alarm: (key, title, summary) => alarms.push({ key, title, summary }),
			log: (e, data) => logs.push({ e, ...(data ? { data } : {}) }),
		});
		await relay.pass();
		relay.audit();
		relay.audit();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["steward-wake"]);
		const orphan = alarms.filter((a) => a.key === "desk:wake-unconfigured");
		// Raised on every audit, like the stale and dead-letter alarms: the engine's alarm() applies the one repeat policy.
		expect(orphan).toHaveLength(2);
		expect(orphan[0]!.title).toContain("desk");
		expect(orphan[0]!.summary).toContain("2 outbox rows and 1 held wake");
		expect(orphan[0]!.summary).toContain("desk-1, desk-2");
		expect(orphan[0]!.summary).toContain(`${selfCommand("wakes")} cancel`);
		expect(logs.filter((l) => l.e === "deliver-receiver-unconfigured")).toEqual([
			{ e: "deliver-receiver-unconfigured", data: { receiver: "desk", rows: 2, held: 1 } },
		]);
		// Not dropped and not delivered.
		expect(s.wakes.rows("pending", "desk").map((r) => r.deliveryId)).toEqual(["desk-1", "desk-2"]);
		expect(s.wakes.held("desk")).toHaveLength(1);
		// The operator finds them, with their receiver, and cancels them.
		const out: string[] = [];
		expect(runWakesCli(s, ["list"], (l) => out.push(l))).toBe(0);
		expect(out.find((l) => l.includes("desk-1"))).toContain("for desk");
		expect(runWakesCli(s, ["cancel", "desk-1"], () => {})).toBe(0);
		expect(runWakesCli(s, ["cancel", "desk-2"], () => {})).toBe(0);
		alarms.length = 0;
		relay.audit();
		expect(alarms.filter((a) => a.key === "desk:wake-unconfigured")[0]!.summary).not.toContain("outbox row");
	});
	test("a dead-lettered row for an unconfigured receiver is reported too, and a configured receiver raises no such alarm", () => {
		const s = memStore();
		s.wakes.enqueue(row("gone-1", { receiver: "pager" }));
		s.wakes.finish(s.wakes.find("gone-1")!.id, "dead_letter", Date.now());
		s.wakes.enqueue(row("desk-ok", { receiver: "desk" }));
		const keys: string[] = [];
		const { relay } = both(s, transport().t, transport().t, { alarm: (k) => keys.push(k) });
		relay.audit();
		expect(keys).toContain("pager:wake-unconfigured");
		expect(keys).not.toContain("desk:wake-unconfigured");
	});
	test("a busy desk holds only the desk's wakes: the Steward's go out, and the desk's go as ONE digest when it is idle", async () => {
		const s = memStore();
		const steward = transport(),
			desk = transport();
		let deskGate: Gate = "busy";
		s.wakes.hold(row("d1", { kind: "alert_desk", receiver: "desk", queuedAt: 1 }));
		s.wakes.hold(row("d2", { kind: "alert_desk", receiver: "desk", queuedAt: 2 }));
		s.wakes.hold(row("s1", { kind: "sweep", queuedAt: 3 }));
		const { relay } = both(s, steward.t, desk.t, { deskGate: () => deskGate });
		await relay.pass();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["s1"]);
		expect(desk.sent).toEqual([]);
		expect(s.wakes.held("desk")).toHaveLength(2);
		deskGate = "idle";
		await relay.pass();
		expect(desk.sent).toHaveLength(1);
		expect(desk.sent[0]!.message).toContain("digest: 2 wakes");
		expect(s.wakes.held()).toEqual([]);
		expect(s.wakes.rows("delivered", "desk")).toHaveLength(1);
		expect(s.wakes.rows("delivered", "desk")[0]).toMatchObject({ receiver: "desk", kind: "digest" });
	});
	test("a desk with no URL raises its own alarm and never the Steward's, and the Steward's wakes still go", async () => {
		const s = memStore();
		const alarms: string[] = [];
		const steward = transport();
		const notReady: WakeTransport = { ready: () => false, send: async () => ({ ok: false }) };
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.enqueue(row("steward-wake", { kind: "needs_input" }));
		const { relay } = both(s, steward.t, notReady, { alarm: (key) => alarms.push(key) });
		await relay.pass();
		expect(alarms).toEqual(["desk:wake-not-ready"]);
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["steward-wake"]);
	});
	test("attempts, dead letters and alarms are per receiver: a failing desk dead-letters its own row and alarms under its own key", async () => {
		const s = memStore();
		const alarms: string[] = [];
		const steward = transport();
		const failing: WakeTransport = { ready: () => true, send: async () => ({ ok: false, status: 500 }) };
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		s.wakes.enqueue(row("steward-wake", { kind: "needs_input" }));
		const { relay, drain } = both(s, steward.t, failing, { alarm: (key) => alarms.push(key) });
		await drain();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["steward-wake"]);
		expect(s.wakes.rows("dead_letter", "desk").map((r) => [r.deliveryId, r.attempts])).toEqual([["desk-wake", 3]]);
		expect(new Set(alarms)).toEqual(new Set(["desk:wake-delivery", "desk:wake-dead-letter"]));
		expect(relay.failures()).toBe(0);
		expect(relay.failures("desk")).toBe(3);
	});
	test("there is one relay per lock: a second relay on the same lock is refused", () => {
		const s = memStore();
		const lock = testRelayLock(s);
		const base = { store: s, lock, wake: transport().t, gate: () => "idle" as Gate, log: () => {}, alarm: () => {} };
		expect(() => createRelay(base)).not.toThrow();
		expect(() => createRelay({ ...base, wake: transport().t })).toThrow("a relay already exists on this lock");
	});
});

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
		writeFileSync(`${conf}/alert-desk.json`, JSON.stringify({ morningHour: 23, ...desk }));
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
			relay: { retryAfterMs: () => 0 },
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
			relay: { retryAfterMs: () => 0 },
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

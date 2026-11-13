/**
 * The desk as a second wake receiver: rows and held wakes are kept per receiver, a relay sends only its own, and the desk's gate holds only
 * the desk's wakes. Then the engine, against the fake adapter, drains a real inbox file into the desk transport and never into the Steward's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WakeTransport } from "./deliver.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { testRelayLock } from "../testing/lock.ts";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { openStore } from "./sqlite-store.ts";
import { createEngine } from "./engine.ts";
import type { Gate } from "./hold.ts";

const transport = () => {
	const sent: { deliveryId: string; message: string }[] = [];
	const t: WakeTransport = { ready: () => true, send: async (deliveryId, message) => { sent.push({ deliveryId, message }); return { ok: true, status: 202 }; } };
	return { t, sent };
};
const row = (deliveryId: string, over: Record<string, unknown> = {}) => ({ deliveryId, message: `m ${deliveryId}`, queuedAt: Date.now(), ...over });

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
		const composed = s.wakes.compose(Date.now(), (held) => ({ deliveryId: "row1", message: "x", folded: 0, members: held.map((h) => h.deliveryId), kind: "alert_desk", receiver: "desk" }), "desk");
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

describe("two relays, one store", () => {
	test("each relay sends only its own receiver's wakes, through its own transport", async () => {
		const s = memStore();
		const steward = transport(), desk = transport();
		s.wakes.enqueue(row("steward-wake", { kind: "needs_input" }));
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		await testRelay(s, steward.t).drain();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["steward-wake"]);
		expect(desk.sent).toEqual([]);
		await testRelay(s, desk.t, { receiver: "desk" }).drain();
		expect(desk.sent.map((x) => x.deliveryId)).toEqual(["desk-wake"]);
		expect(steward.sent).toHaveLength(1);
	});
	test("a busy desk holds only the desk's wakes: the Steward's go out, and the desk's go as ONE digest when it is idle", async () => {
		const s = memStore();
		const steward = transport(), desk = transport();
		let deskGate: Gate = "busy";
		s.wakes.hold(row("d1", { kind: "alert_desk", receiver: "desk", queuedAt: 1 }));
		s.wakes.hold(row("d2", { kind: "alert_desk", receiver: "desk", queuedAt: 2 }));
		s.wakes.hold(row("s1", { kind: "sweep", queuedAt: 3 }));
		const stewardRelay = testRelay(s, steward.t).relay;
		const deskRelay = testRelay(s, desk.t, { receiver: "desk", gate: () => deskGate }).relay;
		await stewardRelay.pass();
		await deskRelay.pass();
		expect(steward.sent.map((x) => x.deliveryId)).toEqual(["s1"]);
		expect(desk.sent).toEqual([]);
		expect(s.wakes.held("desk")).toHaveLength(2);
		deskGate = "idle";
		await deskRelay.pass();
		expect(desk.sent).toHaveLength(1);
		expect(desk.sent[0]!.message).toContain("digest: 2 wakes");
		expect(s.wakes.held()).toEqual([]);
		expect(s.wakes.rows("delivered", "desk")).toHaveLength(1);
		expect(s.wakes.rows("delivered", "desk")[0]).toMatchObject({ receiver: "desk", kind: "digest" });
	});
	test("a desk with no URL raises its own alarm and never the Steward's", async () => {
		const s = memStore();
		const alarms: string[] = [];
		const notReady: WakeTransport = { ready: () => false, send: async () => ({ ok: false }) };
		s.wakes.enqueue(row("desk-wake", { kind: "alert_desk", receiver: "desk" }));
		const { relay } = testRelay(s, notReady, { receiver: "desk", alarm: (key) => alarms.push(key) });
		await relay.pass();
		expect(alarms).toEqual(["desk:wake-not-ready"]);
	});
});

describe("the engine drains the inbox into the desk", () => {
	const dirs: string[] = [];
	const engines: { stop: () => Promise<void> }[] = [];
	const saved = process.env.ALERT_DESK_INBOX;
	afterEach(async () => {
		for (const e of engines.splice(0)) await e.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		if (saved === undefined) delete process.env.ALERT_DESK_INBOX; else process.env.ALERT_DESK_INBOX = saved;
	});
	function rig(caps?: Parameters<typeof createFakeAdapter>[0]) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-desk-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "ask", { mode: 0o600 });
		writeFileSync(`${conf}/alert-desk.json`, JSON.stringify({ morningHour: 23 }));
		process.env.ALERT_DESK_INBOX = `${root}/inbox.jsonl`;
		const store = memStore();
		const fake = createFakeAdapter(caps);
		const engine = createEngine({
			conf, lock: testRelayLock(store), store, housekeeping: true, servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: () => {}, timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 }, relay: { retryAfterMs: () => 0 },
		});
		engines.push(engine);
		void engine.start();
		return { root, fake, engine, store };
	}
	const alert = (family: string) => `${JSON.stringify({ v: 1, source: "monitor", family, title: `${family} down`, body: "b", ts: new Date().toISOString(), severity: "critical" })}\n`;

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
	test("a backend without the alertDesk capability never reads the inbox", async () => {
		const r = rig({ capabilities: ["answer", "listWaiting", "setTitle", "transcriptPath", "inspect", "send", "stewardProbe", "compact"] });
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

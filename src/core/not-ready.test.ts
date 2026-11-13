/**
 * A wake with nowhere to go yet (no wake URL configured) is queued and kept, not dropped. The notification decision that made it is
 * recorded in the same transaction (see engine.test.ts), so dropping the wake would lose the alert for good: the item reads as notified
 * and nothing is ever sent. Only a dry run, which asks for exactly that, queues nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { recordingWake } from "../testing/wake.ts";
import { createOutbox } from "./deliver.ts";
import { createEngine } from "./engine.ts";
import { createRelay } from "./relay.ts";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(o: { ready: boolean; dry?: boolean }) {
	const store = memStore();
	const rec = recordingWake();
	const state = { ready: o.ready };
	const alarms: string[] = [];
	const outbox = createOutbox({ store, log: () => {}, dry: o.dry });
	const relay = createRelay({ store, lock: testRelayLock(store), wake: { ready: () => state.ready, send: rec.wake.send }, gate: () => "idle", log: () => {}, alarm: (k) => alarms.push(k) });
	return { store, rec, state, alarms, outbox, relay };
}

describe("no wake URL yet", () => {
	test("a wake is queued and kept with no attempt used, an alarm says why, and it goes once there is somewhere to send", async () => {
		const r = rig({ ready: false });
		expect(r.outbox.deliver("[chamberlain] needs_input: thread X", "t1:needs_input:r1:1", { kind: "needs_input", thread: "t1" })).toBe("queued");
		for (let i = 0; i < 3; i++) expect(await r.relay.pass()).toEqual([]);
		expect(r.rec.accepted).toEqual([]);
		expect(r.store.wakes.rows()).toMatchObject([{ deliveryId: "t1:needs_input:r1:1", attempts: 0 }]);
		expect(r.alarms).toContain("wake-not-ready");
		r.state.ready = true;
		expect(await r.relay.pass()).toEqual(["t1:needs_input:r1:1"]);
		expect(r.rec.accepted.map((w) => w.deliveryId)).toEqual(["t1:needs_input:r1:1"]);
		expect(r.store.wakes.rows()).toEqual([]);
	});

	test("a held kind (a sweep) is kept in the held store and goes in the next digest", async () => {
		const r = rig({ ready: false });
		r.outbox.deliver("[chamberlain] sweep: the disk is full", "sweep:1", { kind: "sweep" });
		await r.relay.pass();
		expect(r.store.wakes.held().map((h) => h.deliveryId)).toEqual(["sweep:1"]);
		r.state.ready = true;
		expect(await r.relay.pass()).toEqual(["sweep:1"]);
		expect(r.rec.accepted).toHaveLength(1);
		expect(r.rec.accepted[0]!.message).toContain("the disk is full");
	});

	test("a dry run, which asks for it, queues nothing", async () => {
		const r = rig({ ready: true, dry: true });
		expect(r.outbox.deliver("m", "id-1", { kind: "needs_input" })).toBe("dry");
		expect(r.store.wakes.rows("all")).toEqual([]);
		await r.relay.pass();
		expect(r.rec.accepted).toEqual([]);
	});
});

describe("the engine with no wake URL", () => {
	test("an event that arrives before the URL is configured still wakes the Steward once it is", async () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-notready-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "rights", { mode: 0o600 });
		const fake = createFakeAdapter({ wakeReady: false });
		fake.threads.set("t1", { lastMessage: "stuck", waiting: [{ type: "user_input_request", requestId: "req-1", label: "Pick", questions: [{ question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }] }] }] });
		const store = memStore();
		const engine = createEngine({ conf, lock: testRelayLock(store), store, servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }], housekeeping: false, log: () => {}, timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 } });
		void engine.start();
		stops.push(() => engine.stop());
		fake.emit({ kind: "needs_input", thread: { id: "t1", title: "Build", status: "waiting", pendingRequestId: "req-1" } });
		await Bun.sleep(100);
		// The alert is on record as notified AND its wake is waiting: neither exists without the other.
		expect(engine.notified().has("req:req-1")).toBe(true);
		expect(store.wakes.rows()).toHaveLength(1);
		expect(fake.wakes).toEqual([]);
		fake.setWakeReady(true);
		await engine.tick();
		expect(fake.wakes).toHaveLength(1);
		expect(fake.wakes[0]!.message).toContain("Merge now?");
		expect(store.wakes.rows()).toEqual([]);
	});
});

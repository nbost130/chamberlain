/** A. In-flight POSTs across a Steward switch commit. */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../../testing/lock.ts";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { composeWake } from "../decide/hold.ts";
import { createOutbox } from "../delivery/deliver.ts";
import { createRelay } from "../delivery/relay.ts";
import { commitSwitch } from "./steward-commit.ts";
import { isDischarged } from "./steward-discharge.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, fakeClock, writeSwitchRefs } = useStewardSwitchFixtures();

describe("A. in-flight POSTs at switch commit", () => {
	test("A1: POST to g1 in flight at commit, then accepted — R transferred; discharged only by g2 receipt", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		createOutbox({ store, log: () => {}, now: () => clock.t }).deliver("payload R", "R-a1");

		let release!: () => void;
		const gate = new Promise<{ ok: boolean; status: number }>((ok) => {
			release = () => ok({ ok: true, status: 202 });
		});
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			maxAttempts: 3,
			retryAfterMs: () => 0,
			wake: { ready: () => true, send: async () => gate },
		});

		const pass = relay.pass();
		await Bun.sleep(10);
		expect(store.wakes.find("R-a1")).toMatchObject({ status: "pending", attempts: 1, attemptGen: 1 });

		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		expect(store.steward.maxGen()).toBe(2);

		release();
		await pass;
		const row = store.wakes.find("R-a1")!;
		expect(row.status).toBe("delivered");
		expect(store.steward.ledger(row.id)).toMatchObject({ gen: 1, origin: "live" });

		transferPass(store, clock.t);
		const item = store.steward.transferItemForOrig(1, row.id);
		expect(item).toBeDefined();
		expect(isDischarged(store, row.id)).toBe(false);

		const composed = store.wakes.compose(clock.t, (held) =>
			composeWake(
				held.filter((h) => h.kind === "transfer"),
				clock.t,
			),
		);
		expect(composed).toBeDefined();
		store.wakes.finish(composed!.id, "delivered", clock.t);
		store.steward.insertLedger({ outboxId: composed!.id, gen: 2, origin: "live" });
		store.steward.insertReceipt({
			outboxId: composed!.id,
			kind: "t3-run",
			runId: "run-g2",
			thread: "thread-g2",
			recordedAt: clock.t,
		});
		expect(isDischarged(store, row.id)).toBe(true);
	});

	test("A2: POST refused — R retried at g2 with no transfer item", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		createOutbox({ store, log: () => {}, now: () => clock.t }).deliver("m", "R-a2");

		let release!: () => void;
		const gate = new Promise<{ ok: boolean; status: number }>((ok) => {
			release = () => ok({ ok: false, status: 503 });
		});
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			maxAttempts: 3,
			retryAfterMs: () => 0,
			wake: { ready: () => true, send: async () => gate },
		});
		const pass = relay.pass();
		await Bun.sleep(10);
		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		release();
		await pass;
		expect(store.wakes.find("R-a2")!.status).toBe("pending");
		expect(store.wakes.find("R-a2")!.attemptGen).toBeUndefined();
		transferPass(store, clock.t);
		expect(store.steward.transferItemForOrig(1, store.wakes.find("R-a2")!.id)).toBeUndefined();

		const relay2 = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			maxAttempts: 3,
			retryAfterMs: () => 0,
			wake: { ready: () => true, send: async () => ({ ok: true, status: 202 }) },
		});
		await relay2.pass();
		const row = store.wakes.find("R-a2")!;
		expect(row.status).toBe("delivered");
		expect(store.steward.ledger(row.id)?.gen).toBe(2);
	});

	test("A5: beginAttempt(expectGen=g1) refuses after commit", () => {
		const w = confWorld();
		const clock = fakeClock();
		const store = memStoreSeeded(w.conf, clock.t);
		const prep = prepareSwitch(store, w.conf, { toThread: "thread-g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(store, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);

		createOutbox({ store, log: () => {}, now: () => clock.t }).deliver("m2", "R-a5b");
		const id2 = store.wakes.find("R-a5b")!.id;
		expect(store.wakes.beginAttempt(id2, clock.t, 1)).toBeUndefined();
		expect(store.wakes.beginAttempt(id2, clock.t, 2)).toBe(1);
	});
});

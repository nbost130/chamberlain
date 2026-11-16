/**
 * M4: seal pending-attempt guard, transfer pointer rights, A4, publish fsync order.
 */
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { testRelayLock } from "../../testing/lock.ts";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { createOutbox } from "../delivery/deliver.ts";
import { createRelay } from "../delivery/relay.ts";
import { needsRights } from "./rights-sent.ts";
import { commitSwitch } from "./steward-commit.ts";
import { publishSwitchRef } from "./steward-gens.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, writeSwitchRefs, fakeClock, deliverAndLedger } = useStewardSwitchFixtures();

describe("M4: seal, transfer rights, A4, publish ordering", () => {
	test("pending attempt_gen blocks seal until cleared (A4 / seal guard)", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		createOutbox({ store: s, log: () => {}, now: () => clock.t }).deliver("in flight", "R-a4");
		let release!: (r: { ok: boolean; status?: number }) => void;
		const gate = new Promise<{ ok: boolean; status?: number }>((ok) => {
			release = ok;
		});
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			wake: { ready: () => true, send: async () => gate },
		});
		const pass = relay.pass();
		await Bun.sleep(10);
		expect(s.wakes.find("R-a4")).toMatchObject({ status: "pending", attemptGen: 1 });

		const prep = prepareSwitch(s, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(s, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);

		transferPass(s, clock.t);
		expect(s.steward.transfer(1)?.sealedAt).toBeUndefined();

		release({ ok: true, status: 202 });
		await pass;
		// R landed at g1; still pending attempt cleared on deliver — seal may proceed after transfer pass.
		expect(s.wakes.find("R-a4")!.status).toBe("delivered");
		expect(s.steward.ledger(s.wakes.find("R-a4")!.id)?.gen).toBe(1);
		transferPass(s, clock.t);
		expect(s.steward.transfer(1)?.sealedAt).toBeDefined();
		expect(s.steward.transferItemForOrig(1, s.wakes.find("R-a4")!.id)).toBeDefined();
	});

	test("A4: injected delivered-commit failure — seal blocked until land; then transfer", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const base = memStoreSeeded(w.conf, clock.t);
		let failLand = true;
		const s = {
			...base,
			wakes: {
				...base.wakes,
				finish: (id: number, status: "delivered" | "dead_letter", now: number) => {
					if (failLand && status === "delivered") throw new Error("injected land fail");
					return base.wakes.finish(id, status, now);
				},
			},
		};
		createOutbox({ store: s, log: () => {}, now: () => clock.t }).deliver("in flight", "R-a4-land");
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			wake: { ready: () => true, send: async () => ({ ok: true, status: 202 }) },
		});
		await relay.pass();
		expect(s.wakes.find("R-a4-land")).toMatchObject({ status: "pending", attemptGen: 1 });

		const prep = prepareSwitch(s, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(s, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		transferPass(s, clock.t);
		expect(s.steward.transfer(1)?.sealedAt).toBeUndefined();
		expect(s.steward.transferItemForOrig(1, s.wakes.find("R-a4-land")!.id)).toBeUndefined();

		failLand = false;
		await relay.pass();
		expect(s.wakes.find("R-a4-land")!.status).toBe("delivered");
		expect(s.steward.ledger(s.wakes.find("R-a4-land")!.id)?.gen).toBe(1);
		transferPass(s, clock.t);
		expect(s.steward.transfer(1)?.sealedAt).toBeDefined();
		expect(s.steward.transferItemForOrig(1, s.wakes.find("R-a4-land")!.id)).toBeDefined();
	});

	test("transfer items carry pointer-class rights stamp (needsRights)", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = deliverAndLedger(s, { deliveryId: "R-rights", message: "p", at: 1, gen: 1 });
		const prep = prepareSwitch(s, w.conf, { toThread: "g2", live: true });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(s, w.conf, { id: prep.id, live: true }).ok).toBe(true);
		transferPass(s);
		const itemId = s.steward.transferItemForOrig(1, id)!.itemId;
		const held = s.wakes.held().find((h) => h.deliveryId === itemId);
		expect(held).toBeDefined();
		expect(needsRights(held!.rights)).toBe(true);
	});

	test("relay sends rights before a transfer item POST", async () => {
		const w = confWorld();
		const clock = fakeClock();
		const s = memStoreSeeded(w.conf, clock.t);
		const id = deliverAndLedger(s, { deliveryId: "R-prereq", message: "p", at: clock.t, gen: 1 });
		const prep = prepareSwitch(s, w.conf, { toThread: "g2", live: true, now: clock.t });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		expect(commitSwitch(s, w.conf, { id: prep.id, live: true, now: clock.t }).ok).toBe(true);
		// Deliver the switch notice first so it does not interleave with the transfer rights check.
		const notice = s.wakes.rows("pending", null).find((r) => r.kind === "switch_notice")!;
		s.wakes.finish(notice.id, "delivered", clock.t);
		s.steward.insertLedger({ outboxId: notice.id, gen: 2, origin: "live" });
		transferPass(s, clock.t);
		const itemId = s.steward.transferItemForOrig(1, id)!.itemId;
		s.wakes.compose(clock.t, (held) => {
			const h = held.find((x) => x.deliveryId === itemId)!;
			return {
				deliveryId: h.deliveryId,
				message: h.message,
				members: [h.deliveryId],
				kept: [h.deliveryId],
				folded: 0,
				kind: "transfer",
				rights: h.rights,
			};
		});
		const hash = "c".repeat(64);
		const posts: string[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			now: () => clock.t,
			rightsNow: async () => ({
				hash,
				steward: "g2",
				wake: (forId) => ({ message: `full rights for ${forId}`, stamp: { hash, full: true as const } }),
			}),
			wake: {
				ready: () => true,
				send: async (deliveryId) => {
					posts.push(deliveryId);
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		// Pointer stamp forces a rights-first prerequisite before the transfer item itself.
		expect(posts.length).toBeGreaterThan(0);
		expect(posts[0]).toContain("rights-first");
		expect(posts.includes(itemId)).toBe(false);
		s.state.set("rights-sent", { hash, steward: "g2", epoch: 0 });
		posts.length = 0;
		await relay.pass();
		expect(posts).toContain(itemId);
		expect(posts.every((p) => !p.includes("rights-first") || posts.indexOf(p) < posts.indexOf(itemId))).toBe(true);
	});

	test("publishSwitchRef: mode 0600; never overwrite (C5 order spy lives in r5-evidence)", () => {
		const w = confWorld();
		const prep = prepareSwitch(memStoreSeeded(w.conf), w.conf, { toThread: "t", live: true });
		if (!prep.ok) throw new Error(prep.error);
		expect(publishSwitchRef(w.conf, prep.id, "wake", "https://fake.example/a\n")).toBe(true);
		const path = `${w.conf}/secrets/steward/${prep.id}.wake`;
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(publishSwitchRef(w.conf, prep.id, "wake", "https://fake.example/b\n")).toBe(false);
	});
});

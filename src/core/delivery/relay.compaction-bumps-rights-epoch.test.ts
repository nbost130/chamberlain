/** relay, continued: see relay.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { openStore } from "../store/sqlite-store.ts";
import { createRelay } from "./relay.ts";

const { scratch, H1, pointer, fullAt, compactWorld } = useCoreRelayFixtures(createRelay);

describe("a compaction bumps the rights epoch inside its serial job: a full block composed before it never restores the record", () => {
	describe("a crash at each point of that interleaving (a fresh relay over the same database is the restart)", () => {
		const fileStore = () => openStore(`${scratch()}/epoch.db`);

		test("after F was accepted, before its delivered commit, with the compaction still queued: the restart compacts, then re-sends F, which writes nothing, and P gets a prerequisite", async () => {
			const r = compactWorld({ store: fileStore() });
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			// The dying relay: F accepted, its commit never made, the process gone before the compaction's job ran.
			const dying = createRelay({
				store: r.broken,
				lock: testRelayLock(r.broken),
				gate: () => "idle",
				log: () => {},
				alarm: () => {},
				maxAttempts: 3,
				wake: {
					ready: () => true,
					send: async (id) => {
						r.posts.push({ id, message: "" });
						return { ok: true, status: 202 };
					},
				},
			});
			await dying.pass();
			expect(r.store.wakes.find("F")).toMatchObject({ status: "pending", attempts: 1 });
			r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
			const relay = r.relay();
			await relay.compact("compact:steward-1:1");
			await relay.pass();
			// The restart's compaction ran first (nothing of F was recorded yet); F re-sent after it carries epoch 0 and writes nothing.
			expect(r.ids()).toEqual(["F", "compact:steward-1:1", "F", r.prereq("P", 1), "P"]);
			expect(r.record()).toMatchObject({ hash: H1, epoch: 1 });
		});

		test("after F was delivered, before the compaction's job ran: the record is epoch 0; the compaction asked for after the restart drops it, and P gets a prerequisite", async () => {
			const r = compactWorld({ store: fileStore() });
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			await r.relay().pass();
			expect(r.record()).toMatchObject({ epoch: 0, hash: H1 });
			const relay = r.relay();
			await relay.compact("compact:steward-1:1");
			r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
			await relay.pass();
			expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		});

		test("after the epoch bump, before the compaction POST (crash step compact-invalidated): the record stays dropped, and P gets a prerequisite", async () => {
			const fails = { value: true };
			const r = compactWorld({ store: fileStore(), compactFails: fails });
			const f = r.fullInFlight();
			const dying = r.relay();
			const passing = dying.pass();
			await r.until(f.started);
			// The compaction is asked for while F is open; its job bumps the epoch, then the process dies before the POST.
			const compacting = dying.compact("compact:steward-1:1").catch(() => "killed");
			f.release();
			expect(await compacting).toBe("killed");
			await passing;
			expect(r.record()).toEqual({ epoch: 1 });
			fails.value = false;
			r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
			await r.relay().pass();
			expect(r.ids()).toEqual(["F", r.prereq("P", 1), "P"]);
		});

		test("after the bump, with F's delivered commit still owed (crash before it landed): the restart re-sends F, which writes nothing, and P gets a prerequisite", async () => {
			const r = compactWorld({ store: fileStore() });
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			const dying = createRelay({
				store: r.broken,
				lock: testRelayLock(r.broken),
				gate: () => "idle",
				log: () => {},
				alarm: () => {},
				maxAttempts: 3,
				wake: {
					ready: () => true,
					send: async (id) => {
						r.posts.push({ id, message: "" });
						return { ok: true, status: 202 };
					},
				},
				compact: {
					ready: () => true,
					send: async (id) => {
						r.posts.push({ id, message: "" });
						return { ok: true, status: 202 };
					},
				},
			});
			await dying.pass();
			await dying.compact("compact:steward-1:1");
			expect(r.record()).toEqual({ epoch: 1 });
			r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
			await r.relay().pass();
			expect(r.ids()).toEqual(["F", "compact:steward-1:1", "F", r.prereq("P", 1), "P"]);
			expect(r.events.find((e) => e.event === "rights-full-stale")?.data).toMatchObject({
				deliveryId: "F",
				epoch: 0,
				current: 1,
			});
		});

		test("after the compaction POST was accepted: the restart reads epoch 1 and no record, and P gets a prerequisite", async () => {
			const r = compactWorld({ store: fileStore() });
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			const dying = r.relay();
			await dying.pass();
			await dying.compact("compact:steward-1:1");
			r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
			await r.relay().pass();
			expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		});
	});
});

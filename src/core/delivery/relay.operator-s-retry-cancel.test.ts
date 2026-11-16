/** relay, continued: see relay.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../../testing/core-relay-fixtures.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { openStore } from "../store/sqlite-store.ts";
import { createOutbox, MAX_ATTEMPTS, maxAttemptsFromEnv } from "./deliver.ts";
import { createRelay } from "./relay.ts";
import { runWakesCli } from "./wakes-cli.ts";

const { scratch, rig } = useCoreRelayFixtures(createRelay);

describe("the operator's retry and cancel", () => {
	test("cancelling a digest (by a member's id) keeps a tombstone with its members, and none of them is ever queued or held again", async () => {
		const r = rig();
		r.sweep("a");
		r.sweep("b");
		r.w.answer = async () => {
			throw Error("unknown");
		};
		await r.relay().pass();
		expect(runWakesCli(r.store, ["cancel", "a"], () => {})).toBe(0);
		const row = r.store.wakes.find("a")!;
		expect(row).toMatchObject({ status: "cancelled", kind: "digest" });
		expect(row.members.map((m) => m.deliveryId)).toEqual(["a", "b"]);
		expect(r.sweep("a")).toBe("known");
		expect(r.outbox.deliver("again", "b")).toBe("known");
		expect(r.store.wakes.held()).toEqual([]);
		r.clock.t += 1001;
		await r.relay().pass();
		expect(r.posts).toHaveLength(1);
		expect(r.store.wakes.isDelivered("a")).toBe(false);
	});

	test("a cancelled member is refused after retention prunes its row: cancel, prune, then enqueue and hold are both refused (one row ever, never enqueued again)", async () => {
		const r = rig();
		r.sweep("a");
		r.sweep("b");
		r.w.answer = async () => {
			throw Error("unknown");
		};
		await r.relay().pass();
		expect(runWakesCli(r.store, ["cancel", "a"], () => {})).toBe(0);
		expect(r.store.wakes.prune(Date.now() + 1000)).toBe(1); // retention deletes the row, and the cascade deletes its member bindings
		expect(r.store.wakes.rows("all")).toEqual([]);
		expect(r.store.wakes.find("a")).toBeUndefined();
		expect(r.store.wakes.known("a")).toBe(true);
		expect(r.store.wakes.known("b")).toBe(true); // the digest's other member, folded into the same cancelled row
		expect(r.sweep("a")).toBe("known");
		expect(r.outbox.deliver("again", "b")).toBe("known");
		expect(r.store.wakes.enqueue({ deliveryId: "a", message: "again", queuedAt: r.clock.t })).toBe(false);
		expect(r.store.wakes.hold({ deliveryId: "b", message: "again", queuedAt: r.clock.t })).toBe(false);
		expect(r.store.wakes.held()).toEqual([]);
		r.clock.t += 1001;
		await r.relay().pass();
		expect(r.posts).toHaveLength(1); // only the one unknown-outcome attempt from before the cancel
		expect(r.store.wakes.isDelivered("a")).toBe(false);
	});

	test("a delivered id is refused after retention too, and a tombstone can be neither changed nor deleted", async () => {
		const path = `${scratch()}/tomb.db`;
		const store = openStore(path);
		try {
			const r = rig({ store });
			r.sweep("d");
			await r.relay().pass();
			store.steward.insertLedger({
				outboxId: store.wakes.find("d")!.id,
				gen: 1,
				origin: "unrecoverable",
			});
			expect(store.wakes.prune(r.clock.t + 1)).toBe(1);
			expect(store.wakes.isDelivered("d")).toBe(true);
			expect(r.sweep("d")).toBe("known");
			const raw = new Database(path);
			try {
				expect(raw.query("SELECT delivery_id, outcome FROM wake_tombstones").all()).toEqual([
					{ delivery_id: "d", outcome: "delivered" },
				]);
				expect(() => raw.exec("DELETE FROM wake_tombstones")).toThrow(/permanent/);
				expect(() => raw.exec("UPDATE wake_tombstones SET outcome = 'cancelled'")).toThrow(/permanent/);
			} finally {
				raw.close();
			}
		} finally {
			store.close();
		}
	});

	test("opening a database from before the tombstones backfills one per delivered or cancelled id, digest members included", () => {
		const path = `${scratch()}/v6.db`;
		const raw = new Database(path);
		raw.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
			raw.exec(m.sql);
			raw.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		raw.exec(`INSERT INTO outbox (id, delivery_id, message, created_at, status, finished_at) VALUES (1, 'dig', 'm', 1, 'cancelled', 5), (2, 'ok', 'm', 1, 'delivered', 6), (3, 'wait', 'm', 1, 'pending', NULL);
			INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES ('a', 1, 1), ('b', 1, 1), ('ok', 2, 1), ('wait', 3, 1);`);
		raw.close();
		const store = openStore(path);
		try {
			expect([...["a", "b", "ok", "wait", "nope"]].map((id) => store.wakes.known(id))).toEqual([
				true,
				true,
				true,
				true,
				false,
			]);
			store.wakes.prune(1e12);
			expect(["a", "b", "ok", "wait", "nope"].map((id) => store.wakes.known(id))).toEqual([
				true,
				true,
				true,
				true,
				false,
			]);
			expect(store.wakes.isDelivered("ok")).toBe(true);
			expect(store.wakes.isDelivered("a")).toBe(false);
		} finally {
			store.close();
		}
	});

	test("a cancel while the POST is out stands: the accepted POST does not reopen the row", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = () =>
			new Promise((ok) => {
				release = () => ok({ ok: true });
			});
		r.outbox.deliver("x", "w1");
		const sending = r.relay().pass();
		await Bun.sleep(5);
		expect(runWakesCli(r.store, ["cancel", "w1"], () => {})).toBe(0);
		release();
		await sending;
		expect(r.store.wakes.find("w1")!.status).toBe("cancelled");
		expect(r.events.map((e) => e.event)).toContain("delivered-after-cancel");
	});

	test("list says what is dead, pending and held; an unknown id and bad usage say so", () => {
		const r = rig();
		r.outbox.deliver("x", "p1");
		r.sweep("h1");
		const out: string[] = [];
		expect(runWakesCli(r.store, ["list"], (l) => out.push(l))).toBe(0);
		expect(out.join("\n")).toContain("pending (the daemon's relay is sending them): 1");
		expect(out.join("\n")).toContain("held for the Steward to go idle: 1");
		expect(runWakesCli(r.store, ["retry", "nope"], () => {})).toBe(1);
		expect(runWakesCli(r.store, [], () => {})).toBe(2);
	});

	test("bun src/wakes.ts runs list, retry and cancel on the real database, and its exit codes say what happened", async () => {
		const dir = scratch();
		const state = `${dir}/state`;
		const s = openStore(`${state}/chamberlain.db`);
		s.wakes.enqueue({ deliveryId: "stuck-1", message: "m", queuedAt: 1000 });
		const id = s.wakes.find("stuck-1")!.id;
		for (let i = 0; i < 3; i++) s.wakes.beginAttempt(id, i);
		s.wakes.finish(id, "dead_letter", 5);
		s.close();
		const run = async (...args: string[]) => {
			const p = Bun.spawn([process.execPath, new URL("../../wakes.ts", import.meta.url).pathname, ...args], {
				env: { ...process.env, HOME: dir, CHAMBERLAIN_STATE: state, CHAMBERLAIN_CONF: `${dir}/conf` },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
			return { out, code };
		};
		const list = await run("list");
		expect(list.code).toBe(0);
		expect(list.out).toContain("stuck-1  3/3 attempts");
		expect((await run("retry", "no-such")).code).toBe(1);
		expect((await run()).code).toBe(2);
		expect((await run("retry", "stuck-1")).out).toContain("pending again");
		expect((await run("cancel", "stuck-1")).code).toBe(0);
		const after = openStore(`${state}/chamberlain.db`);
		try {
			expect(after.wakes.rows("all").map((r) => r.status)).toEqual(["cancelled"]);
		} finally {
			after.close();
		}
	});

	test("the cap is CHAMBERLAIN_MAX_ATTEMPTS, a positive whole number, else three; a relay built without one reads it", async () => {
		expect(MAX_ATTEMPTS).toBe(3);
		expect(maxAttemptsFromEnv({ CHAMBERLAIN_MAX_ATTEMPTS: "5" })).toBe(5);
		for (const bad of ["0", "-2", "2.5", "many", ""])
			expect(maxAttemptsFromEnv({ CHAMBERLAIN_MAX_ATTEMPTS: bad })).toBe(3);
		const before = process.env.CHAMBERLAIN_MAX_ATTEMPTS;
		process.env.CHAMBERLAIN_MAX_ATTEMPTS = "1";
		try {
			const store = memStore();
			const posts: string[] = [];
			createOutbox({ store, log: () => {} }).deliver("m", "env-1");
			const relay = createRelay({
				store,
				lock: testRelayLock(store),
				gate: () => "idle",
				log: () => {},
				alarm: () => {},
				wake: {
					ready: () => true,
					send: async (id) => {
						posts.push(id);
						throw Error("timeout");
					},
				},
			});
			await relay.pass();
			await relay.pass();
			expect(posts).toEqual(["env-1"]);
			expect(store.wakes.find("env-1")!.status).toBe("dead_letter");
		} finally {
			if (before === undefined) delete process.env.CHAMBERLAIN_MAX_ATTEMPTS;
			else process.env.CHAMBERLAIN_MAX_ATTEMPTS = before;
		}
	});
});

describe("a database from before the one relay (migration 5)", () => {
	test("opening it keeps pending rows pending with their attempts, dead letters dead, delivered ids delivered and held items held; the lease table is gone", () => {
		const path = `${scratch()}/old.db`;
		const raw = new Database(path);
		raw.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
			raw.exec(m.sql);
			raw.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		raw.exec(`INSERT INTO outbox (delivery_id, owner, message, queued_at, attempts) VALUES ('p1', 'daemon', 'm', 5, 2);
			INSERT INTO outbox (delivery_id, owner, message, queued_at, attempts, status, dead_at) VALUES ('d1', 'queue-web', 'm', 6, 3, 'dead_letter', 9);
			INSERT INTO outbox (delivery_id, owner, message, queued_at) VALUES ('landed', 'daemon', 'm', 7);
			INSERT INTO delivered_wakes VALUES ('landed', 8), ('old', 4);
			INSERT INTO held_wakes (delivery_id, message, queued_at, kind) VALUES ('h1', 'm', 3, 'sweep'), ('old', 'm', 2, 'sweep');
			INSERT INTO delivery_leases (delivery_id, holder, pid, host, expires_at) VALUES ('p1', 'x', 1, 'h', 0);`);
		raw.close();
		const s = openStore(path);
		try {
			expect(s.wakes.find("p1")).toMatchObject({ status: "pending", attempts: 2 });
			expect(s.wakes.find("d1")).toMatchObject({ status: "dead_letter", attempts: 3 });
			expect(["landed", "old"].map((id) => s.wakes.isDelivered(id))).toEqual([true, true]);
			expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["h1"]);
			const check = new Database(path, { readonly: true });
			expect(
				check.query("SELECT name FROM sqlite_master WHERE name IN ('delivery_leases', 'delivered_wakes')").all(),
			).toEqual([]);
			check.close();
		} finally {
			s.close();
		}
	});
});

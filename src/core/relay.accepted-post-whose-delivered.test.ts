/** relay, continued: see relay.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useCoreRelayFixtures } from "../testing/core-relay-fixtures.ts";
import { createRelay } from "./relay.ts";
import { openStore } from "./sqlite-store.ts";
import type { Store } from "./store.ts";
import { runWakesCli } from "./wakes-cli.ts";

const { scratch, rig } = useCoreRelayFixtures(createRelay);

describe("an accepted POST whose delivered commit fails is never POSTed again by its relay", () => {
	test("however many passes run while the commit fails, one POST; the commit lands when it can", async () => {
		const r = rig();
		let full = true;
		const store: Store = {
			...r.store,
			wakes: {
				...r.store.wakes,
				finish: (id, s, now) => {
					if (full && s === "delivered") throw Error("SQLITE_FULL");
					return r.store.wakes.finish(id, s, now);
				},
			},
		};
		r.outbox.deliver("m", "w1");
		const relay = r.relay(store);
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			r.clock.t += 60_000;
		}
		expect(r.ids()).toEqual(["w1"]);
		expect(r.store.wakes.find("w1")!.status).toBe("pending");
		full = false;
		await relay.pass();
		expect(r.ids()).toEqual(["w1"]);
		expect(r.store.wakes.find("w1")!.status).toBe("delivered");
	});

	test("under a real write lock held by another connection, a row and a digest each go once and land when the lock is gone", async () => {
		const path = `${scratch()}/busy.db`;
		const s = openStore(path, { busyMs: 1 });
		const raw = new Database(path);
		const r = rig({ store: s });
		r.w.answer = async () => {
			raw.exec("BEGIN IMMEDIATE");
			return { ok: true };
		};
		r.outbox.deliver("m", "row");
		r.sweep("ba");
		r.sweep("bb");
		const relay = r.relay();
		// The row's POST takes the lock, so its delivered commit fails; the digest cannot even count an attempt, so it is not POSTed.
		await relay.pass();
		await relay.pass();
		expect(r.ids()).toEqual(["row"]);
		raw.exec("ROLLBACK");
		// The row lands; the digest's POST takes the lock in its turn, and its commit fails the same way.
		await relay.pass();
		expect(s.wakes.find("row")!.status).toBe("delivered");
		await relay.pass();
		expect(r.ids()).toEqual(["row", s.wakes.find("ba")!.deliveryId]);
		expect(s.wakes.isDelivered("ba")).toBe(false);
		raw.exec("ROLLBACK");
		await relay.pass();
		expect(r.posts).toHaveLength(2);
		expect(["ba", "bb"].map((id) => s.wakes.isDelivered(id))).toEqual([true, true]);
		raw.close();
		s.close();
	});

	test("restart after restart, each accepted and none landing, gives exactly maxAttempts POSTs and then a dead letter", async () => {
		const r = rig();
		r.outbox.deliver("x", "cap");
		for (let i = 0; i < 6; i++) {
			await r.relay(r.broken).pass();
			r.clock.t += 600_001;
		}
		expect(r.ids()).toEqual(["cap", "cap", "cap"]);
		expect(r.store.wakes.find("cap")).toMatchObject({ status: "dead_letter", attempts: 3 });
	});

	test("attempts spent with no POST (a crash after the count, before the POST) are still spent: the cap only ever lowers the POSTs", async () => {
		const r = rig();
		r.outbox.deliver("x", "crash");
		const id = r.store.wakes.find("crash")!.id;
		for (let i = 0; i < 3; i++) r.store.wakes.beginAttempt(id, i);
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("crash")).toMatchObject({ status: "dead_letter", attempts: 3 });
	});

	test("a clock jump while a POST is out cannot start a second POST: passes are one at a time and the clock decides nothing about who sends", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = () =>
			new Promise((ok) => {
				release = () => ok({ ok: true });
			});
		r.outbox.deliver("m", "clock");
		const relay = r.relay();
		const first = relay.pass();
		await Bun.sleep(5);
		r.clock.t += 365 * 86400_000;
		const second = relay.pass();
		await Bun.sleep(5);
		expect(r.posts).toHaveLength(1);
		release();
		await Promise.all([first, second]);
		expect(r.posts).toHaveLength(1);
	});
});

describe("a digest is frozen when it is composed", () => {
	test("composition binds the held items to one row; an item held later is never added, and a retry sends the same id and text", async () => {
		const r = rig();
		r.sweep("a");
		r.sweep("b");
		let first = true;
		r.w.answer = async () => {
			if (first) {
				first = false;
				throw Error("timeout");
			}
			return { ok: true };
		};
		const relay = r.relay();
		await relay.pass();
		expect(r.store.wakes.held()).toEqual([]);
		const digest = r.store.wakes.rows()[0]!;
		expect(digest.members.map((m) => m.deliveryId)).toEqual(["a", "b"]);
		r.sweep("c");
		r.clock.t += 1001;
		await r.relay().pass();
		const [p1, p2] = r.posts.filter((p) => p.id === digest.deliveryId);
		expect(p2!.message).toBe(p1!.message);
		expect(p1!.message).not.toContain("text of c");
		// c went in a row of its own: a and b were never sent under a second id.
		expect(r.store.wakes.find("c")!.deliveryId).toBe("c");
		expect(r.posts.filter((p) => p.message.includes("text of a")).map((p) => p.id)).toEqual([
			digest.deliveryId,
			digest.deliveryId,
		]);
	});

	test("a forced (ceiling) digest that times out is sent again as composed, whoever restarts; it never regroups", async () => {
		const r = rig();
		r.w.gate = "busy";
		r.sweep("a");
		r.sweep("b");
		const relay = r.relay();
		relay.audit();
		await relay.pass();
		expect(r.posts).toEqual([]);
		for (let i = 0; i < 5; i++) {
			r.clock.t += 4 * 60_000;
			relay.audit();
		}
		r.w.answer = async () => {
			throw Error("timeout");
		};
		await relay.pass();
		r.sweep("c");
		r.w.answer = async () => ({ ok: true });
		r.clock.t += 1001;
		await r.relay().pass();
		const digestPosts = r.posts.filter((p) => p.id.startsWith("digest:"));
		expect(new Set(digestPosts.map((p) => p.id)).size).toBe(1);
		expect(new Set(digestPosts.map((p) => p.message)).size).toBe(1);
		expect(r.store.wakes.held().map((h) => h.deliveryId)).toEqual(["c"]);
	});

	test("a member delivered nowhere else and enqueued again is refused: its binding is for good, and the digest sends its frozen text", async () => {
		const r = rig();
		r.sweep("a");
		r.sweep("b");
		r.w.answer = async () => {
			throw Error("timeout");
		};
		await r.relay().pass();
		expect(r.sweep("a")).toBe("known");
		expect(r.outbox.deliver("again", "a")).toBe("known");
		expect(r.store.wakes.held()).toEqual([]);
		r.w.answer = async () => ({ ok: true });
		r.clock.t += 1001;
		await r.relay().pass();
		expect(r.posts.at(-1)!.message).toContain("text of a");
	});

	test("two turn ends for one thread fold into the latest at composition, and the row records the fold with both bound", async () => {
		const r = rig();
		r.sweep("t1", "thread-1", "turn_ended");
		r.clock.t += 1;
		r.sweep("t2", "thread-1", "turn_ended");
		r.sweep("s", undefined, "sweep");
		await r.relay().pass();
		const row = r.store.wakes.find("t1")!;
		expect(row).toMatchObject({ folded: 1, kind: "digest", status: "delivered" });
		expect(row.members.map((m) => m.deliveryId).sort()).toEqual(["s", "t1", "t2"]);
		expect(r.posts[0]!.message).toContain("folded 1 earlier turn_ended wake");
	});

	test("the database refuses to change a row's frozen fields, rebind or double-bind a member, reopen a finished row, or delete a live one", async () => {
		const path = `${scratch()}/frozen.db`;
		const s = openStore(path);
		const r = rig({ store: s });
		r.sweep("a");
		r.sweep("b");
		r.w.answer = async () => {
			throw Error("timeout");
		};
		await r.relay().pass();
		r.outbox.deliver("m", "done");
		r.w.answer = async () => ({ ok: true });
		r.clock.t += 1001;
		await r.relay().pass();
		const raw = new Database(path);
		const digest = s.wakes.find("a")!;
		for (const sql of [
			`UPDATE outbox SET message = 'other' WHERE id = ${digest.id}`,
			`UPDATE outbox SET delivery_id = 'other' WHERE id = ${digest.id}`,
			"UPDATE outbox_members SET outbox_id = 99 WHERE delivery_id = 'a'",
			`INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES ('a', ${s.wakes.find("done")!.id}, 0)`,
			"UPDATE outbox SET status = 'pending' WHERE delivery_id = 'done'",
		])
			expect(() => raw.exec(sql)).toThrow();
		raw.exec("PRAGMA foreign_keys = ON");
		r.w.answer = async () => {
			throw Error("timeout");
		};
		r.outbox.deliver("m", "live");
		await r.relay().pass();
		expect(() => raw.exec("DELETE FROM outbox WHERE delivery_id = 'live'")).toThrow();
		raw.close();
		s.close();
	});
});

describe("the operator's retry and cancel", () => {
	test("retry is refused on a pending row, even one whose POST is out, so it never adds a POST beside a live one", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = () =>
			new Promise((ok) => {
				release = () => ok({ ok: true });
			});
		r.outbox.deliver("x", "live");
		const sending = r.relay().pass();
		await Bun.sleep(5);
		const out: string[] = [];
		expect(runWakesCli(r.store, ["retry", "live"], (l) => out.push(l))).toBe(1);
		expect(out.join("\n")).toContain("only a dead letter can be retried");
		release();
		await sending;
		await r.relay().pass();
		expect(r.posts).toHaveLength(1);
	});

	test("retry puts a dead letter back to pending with no attempts used, and the relay sends it under the same id", async () => {
		const r = rig({ max: 1 });
		r.w.answer = async () => ({ ok: false, status: 500 });
		r.outbox.deliver("x", "stuck");
		await r.relay().pass();
		expect(r.store.wakes.find("stuck")!.status).toBe("dead_letter");
		expect(runWakesCli(r.store, ["retry", "stuck"], () => {})).toBe(0);
		expect(r.store.wakes.find("stuck")).toMatchObject({ status: "pending", attempts: 0 });
		r.w.answer = async () => ({ ok: true });
		await r.relay().pass();
		expect(r.ids()).toEqual(["stuck", "stuck"]);
		expect(r.store.wakes.find("stuck")!.status).toBe("delivered");
		expect(runWakesCli(r.store, ["retry", "stuck"], () => {})).toBe(1);
		expect(runWakesCli(r.store, ["cancel", "stuck"], () => {})).toBe(1);
	});
});

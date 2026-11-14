/**
 * The transactional outbox and its one relay. Each failure found in the delivery design is a test here: accepted POSTs that never land (across
 * successive holders), a digest rebuilt under a new id on takeover, a clock jump taking a live holder's lease, attempt reservations spent across
 * boots, a refusal erasing an unknown outcome's history, a retry beside a live POST, and a cancelled digest with no tombstone. Where a case needed
 * two holders, the design has one relay; "a restart" is a fresh relay over the same database, one after another.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { createOutbox, MAX_ATTEMPTS, maxAttemptsFromEnv, type WakeResult, withDeliveryId } from "./deliver.ts";
import type { Gate } from "./hold.ts";
import { MIGRATIONS } from "./migrations.ts";
import { createRelay } from "./relay.ts";
import { type RelayDeps, retryAfterMs } from "./relay-ctx.ts";
import { invalidateRights, RIGHTS_SENT_KEY, rightsEpoch, rightsFirstId, rightsStateKey } from "./rights-sent.ts";
import { openStore } from "./sqlite-store.ts";
import type { Store } from "./store.ts";
import { runWakesCli } from "./wakes-cli.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-relay-`);
	dirs.push(d);
	return d;
};

/** A world: a store, a clock, a webhook whose answer the test sets, and relays (each a fresh process's) over the same store. */
function rig(
	o: { store?: Store; max?: number; rightsNow?: RelayDeps["rightsNow"]; compact?: RelayDeps["compact"] } = {},
) {
	const store = o.store ?? memStore();
	const clock = { t: 1_000_000 };
	const posts: { id: string; message: string }[] = [];
	const alarms: string[] = [];
	const events: { event: string; data?: Record<string, unknown> }[] = [];
	const w = {
		ready: true,
		gate: "idle" as Gate,
		answer: async (_id: string): Promise<WakeResult> => ({ ok: true, status: 202 }),
	};
	const relay = (s: Store = store) =>
		createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => w.gate,
			log: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
			alarm: (k) => alarms.push(k),
			now: () => clock.t,
			maxAttempts: o.max ?? 3,
			retryAfterMs: () => 1000,
			...(o.rightsNow ? { rightsNow: o.rightsNow } : {}),
			...(o.compact ? { compact: o.compact } : {}),
			wake: {
				ready: () => w.ready,
				send: async (id, message) => {
					posts.push({ id, message });
					return w.answer(id);
				},
			},
		});
	const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
	const sweep = (id: string, thread?: string, kind = "sweep") =>
		outbox.deliver(`text of ${id}`, id, { kind, ...(thread ? { thread } : {}) });
	/** A store whose delivered commit fails: a full disk at the one commit that matters. */
	const broken: Store = {
		...store,
		wakes: {
			...store.wakes,
			finish: (id, status, now) => {
				if (status === "delivered") throw Error("SQLITE_FULL: database or disk is full");
				return store.wakes.finish(id, status, now);
			},
		},
	};
	return { store, clock, posts, alarms, events, w, relay, outbox, sweep, broken, ids: () => posts.map((p) => p.id) };
}

describe("the relay sends each row with its attempt committed first", () => {
	test("a wake is a pending row, sent once under its id with the delivery-id line last, then delivered; another pass sends nothing", async () => {
		const r = rig();
		expect(r.outbox.deliver("hello", "w1")).toBe("queued");
		expect(r.store.wakes.rows()).toMatchObject([{ deliveryId: "w1", status: "pending", attempts: 0 }]);
		const relay = r.relay();
		expect(await relay.pass()).toEqual(["w1"]);
		expect(r.posts).toHaveLength(1);
		expect(r.posts[0]!.message.split("\n").at(-1)).toContain("delivery id: w1");
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 1 });
		await relay.pass();
		expect(r.posts).toHaveLength(1);
		expect(r.outbox.deliver("hello", "w1")).toBe("known");
	});

	test("while the POST is out the row already says one attempt, committed", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = () =>
			new Promise((ok) => {
				release = () => ok({ ok: true });
			});
		r.outbox.deliver("m", "w1");
		const pass = r.relay().pass();
		await Bun.sleep(5);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		release();
		await pass;
		expect(r.store.wakes.find("w1")!.status).toBe("delivered");
	});

	test("every outcome counts and none is given back: a timeout, then a refusal, then a 503 use the three attempts, and the row is dead-lettered", async () => {
		const r = rig();
		const outcomes = [
			async (): Promise<WakeResult> => {
				throw Error("timeout after the webhook may have taken it");
			},
			async () => ({ ok: false, error: "connection refused" }),
			async () => ({ ok: false, status: 503 }),
		];
		r.w.answer = () => outcomes[r.posts.length - 1]!();
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 6; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.ids()).toEqual(["w1", "w1", "w1"]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
		expect(r.alarms).toContain("wake-dead-letter");
		r.w.answer = async () => ({ ok: true });
		await r.relay().pass();
		expect(r.posts).toHaveLength(3);
	});

	test("a failed row waits its pause; another row is not held up by it, and a stale one raises an alarm and is kept", async () => {
		const r = rig();
		r.w.answer = async (id) => ({ ok: id === "good" });
		r.outbox.deliver("m", "bad");
		r.outbox.deliver("m", "good");
		const relay = r.relay();
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good"]);
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good"]);
		r.clock.t += 1001;
		await relay.pass();
		expect(r.ids()).toEqual(["bad", "good", "bad"]);
		r.clock.t += 25 * 3600_000;
		relay.audit();
		expect(r.alarms).toContain("wake-stale");
		expect(r.store.wakes.find("bad")!.status).toBe("pending");
		expect(retryAfterMs(1)).toBe(60_000);
		expect(retryAfterMs(2)).toBe(240_000);
	});

	test("with nowhere to send, nothing is attempted and no attempt is used; the alarm says why, and the row goes once there is somewhere", async () => {
		const r = rig();
		r.w.ready = false;
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 5; i++) await relay.pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("w1")!.attempts).toBe(0);
		expect(r.alarms).toEqual(["wake-not-ready"]);
		r.w.ready = true;
		await relay.pass();
		expect(r.ids()).toEqual(["w1"]);
	});
});

describe("what the delivery guarantee says, and what it does not (attempts, the cap, latency, order)", () => {
	test("an attempt is not a POST: three attempts spent by crashes between the count and the POST dead-letter a row nothing ever sent, and the alarm says so", async () => {
		const r = rig();
		r.outbox.deliver("m", "w1");
		const id = r.store.wakes.find("w1")!.id;
		// What a relay that exits after committing its attempt (crash step "attempt-counted") leaves behind, three times over.
		for (let i = 0; i < 3; i++) expect(r.store.wakes.beginAttempt(id, r.clock.t)).toBe(i + 1);
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
		expect(r.store.wakes.isDelivered("w1")).toBe(false);
		expect(r.alarms).toContain("wake-dead-letter");
	});

	test("the cap is per row between explicit retries: a retry allows maxAttempts more, so POSTs in all can pass the cap", async () => {
		const r = rig();
		r.w.answer = async () => ({ ok: false, status: 503 });
		r.outbox.deliver("m", "w1");
		const relay = r.relay();
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.posts).toHaveLength(3);
		expect(runWakesCli(r.store, ["retry", "w1"], () => {})).toBe(0);
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			r.clock.t += 1001;
		}
		expect(r.posts).toHaveLength(6);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "dead_letter", attempts: 3 });
	});

	test("sends are sequential: a stuck send delays the row behind it until the call returns (pickup latency is conditional)", async () => {
		const r = rig();
		let release!: () => void;
		r.w.answer = (id) =>
			id === "first"
				? new Promise((ok) => {
						release = () => ok({ ok: true });
					})
				: Promise.resolve({ ok: true });
		r.outbox.deliver("m", "first");
		r.outbox.deliver("m", "second");
		const relay = r.relay();
		const pass = relay.pass();
		await Bun.sleep(30);
		const queued = relay.pass(); // a second pass cannot start while the first is still sending
		await Bun.sleep(30);
		expect(r.ids()).toEqual(["first"]);
		expect(r.store.wakes.find("second")).toMatchObject({ status: "pending", attempts: 0 });
		release();
		await pass;
		await queued;
		expect(r.ids()).toEqual(["first", "second"]);
	});

	test("order is insertion order with backoff skips, not strict: a later row is delivered before an earlier one that is paused", async () => {
		const r = rig();
		const accepted: string[] = [];
		r.w.answer = async (id) => {
			const ok = id === "later" || r.clock.t > 1_001_000;
			if (ok) accepted.push(id);
			return { ok };
		};
		r.outbox.deliver("m", "earlier");
		r.outbox.deliver("m", "later");
		const relay = r.relay();
		await relay.pass();
		r.clock.t += 2000;
		await relay.pass();
		expect(accepted).toEqual(["later", "earlier"]);
		expect(r.store.wakes.find("earlier")!.id).toBeLessThan(r.store.wakes.find("later")!.id);
	});

	test("a row another process wrote is picked up by the next poll, not at once", async () => {
		const r = rig();
		const relay = r.relay();
		const first = relay.start(60);
		await first;
		r.store.wakes.enqueue({ deliveryId: "from-the-page", message: "m", queuedAt: r.clock.t }); // the page's write: no nudge
		expect(r.posts).toEqual([]);
		await Bun.sleep(250);
		await relay.stop();
		expect(r.ids()).toEqual(["from-the-page"]);
	});
});

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
			const p = Bun.spawn([process.execPath, new URL("../wakes.ts", import.meta.url).pathname, ...args], {
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

describe("the relay cannot exist, or send, without the one-relay lock", () => {
	const base = (store: Store) => ({
		store,
		gate: () => "idle" as Gate,
		log: () => {},
		alarm: () => {},
		wake: { ready: () => true, send: async () => ({ ok: true }) },
	});

	test("createRelay refuses a missing lock, and a look-alike that holdRelayLock did not make, even through a cast", () => {
		const store = memStore();
		expect(() => createRelay(base(store) as never)).toThrow("needs the one-relay lock");
		const lookAlike = { path: "x", held: () => true, release() {} };
		expect(() => createRelay({ ...base(store), lock: lookAlike as never })).toThrow("needs the one-relay lock");
		// The type refuses it too: this line is a compile error without the directive, so `tsc --noEmit` proves the type is closed.
		// @ts-expect-error a plain object is not a RelayLock: only holdRelayLock can make one
		const typed: Parameters<typeof createRelay>[0] = { ...base(store), lock: lookAlike };
		expect(typed).toBeDefined();
	});

	test("createRelay refuses a lock that was already released", () => {
		const store = memStore();
		const lock = testRelayLock();
		lock.release();
		expect(() => createRelay({ ...base(store), lock })).toThrow("needs the one-relay lock");
	});

	test("a relay whose lock is released sends nothing more: no attempt is used, no POST is made, and one event says why", async () => {
		const store = memStore();
		const lock = testRelayLock();
		const posts: string[] = [];
		const events: string[] = [];
		const relay = createRelay({
			...base(store),
			lock,
			log: (e) => events.push(e),
			wake: {
				ready: () => true,
				send: async (id) => {
					posts.push(id);
					return { ok: true };
				},
			},
		});
		store.wakes.enqueue({ deliveryId: "w1", message: "m", queuedAt: 1 });
		lock.release();
		await relay.pass();
		await relay.pass();
		expect(posts).toEqual([]);
		expect(store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		expect(events.filter((e) => e === "relay-lock-released")).toHaveLength(1);
	});

	test("the compaction request goes out through the relay: one attempt, an empty message, refused once the lock is released", async () => {
		const store = memStore();
		const lock = testRelayLock();
		const sent: [string, string][] = [];
		const relay = createRelay({
			...base(store),
			lock,
			compact: {
				ready: () => true,
				send: async (id, message) => {
					sent.push([id, message]);
					return { ok: true, status: 202 };
				},
			},
		});
		expect(relay.compactReady()).toBe(true);
		expect(await relay.compact("compact:t:1")).toEqual({ ok: true, status: 202 });
		expect(sent).toEqual([["compact:t:1", ""]]);
		lock.release();
		await expect(relay.compact("compact:t:2")).rejects.toThrow("no longer holds");
		expect(sent).toHaveLength(1);
		expect(createRelay({ ...base(store), lock: testRelayLock(store) }).compactReady()).toBe(false);
	});
});

describe("a Steward row that depends on the rights goes only when the durable record shows the Steward there now holds them", () => {
	const H1 = "a".repeat(64),
		H2 = "b".repeat(64);
	const stamp = { steward: "steward-1", hash: H1, at: "2026-11-13T18:00:00.000Z" };
	const BLOCK = "Decision rights (standing rules):\nmerge green PRs";
	/** The Steward and rights there are now, which the test moves, and how often the relay asked. */
	function world(o: { max?: number } = {}) {
		const st: { steward?: string; session?: string; hash?: string } = { steward: "steward-1", session: "s1", hash: H1 };
		const asked = { n: 0 };
		const rightsNow: RelayDeps["rightsNow"] = async () => {
			asked.n++;
			const now = { ...st };
			return {
				...now,
				wake: (forId: string) => ({
					message: `[chamberlain] rights for ${forId}\n${now.hash ? BLOCK : "unreadable"}`,
					...(now.hash
						? {
								stamp: {
									...(now.steward ? { steward: now.steward } : {}),
									...(now.session ? { session: now.session } : {}),
									hash: now.hash,
									at: "now",
									used: 10,
									full: true as const,
								},
							}
						: {}),
				}),
			};
		};
		const r = rig({ rightsNow, ...(o.max ? { max: o.max } : {}) });
		const record = () => r.store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
		const firstFor = (row: string) =>
			r.store.wakes.rows("all").filter((w) => w.deliveryId.startsWith(`${row}:rights-first:`));
		const key = () => rightsStateKey(st);
		return { ...r, st, asked, record, firstFor, key };
	}

	test("no record of this Steward: the prerequisite for this state goes first, then the row byte for byte, and its delivery writes the record", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", thread: "t1", rights: [stamp] });
		const F = rightsFirstId("w1", r.key());
		expect(await r.relay().pass()).toEqual([F, "w1"]);
		expect(r.posts[0]!.message).toBe(withDeliveryId(`[chamberlain] rights for w1\n${BLOCK}`, F));
		expect(r.posts[1]!.message).toBe(withDeliveryId("pointer", "w1"));
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", message: "pointer", attempts: 1 });
		expect(r.store.wakes.find(F)).toMatchObject({
			status: "delivered",
			kind: "rights",
			attempts: 1,
			rights: [{ steward: "steward-1", session: "s1", hash: H1, at: "now", used: 10, full: true }],
		});
		expect(r.record()).toEqual({ steward: "steward-1", session: "s1", hash: H1, at: "now", used: 10, epoch: 0 });
		expect(r.events.find((e) => e.event === "rights-first")?.data).toMatchObject({ deliveryId: "w1", first: F });
		await r.relay().pass();
		expect(r.ids()).toEqual([F, "w1"]);
	});

	test("the record shows this state: no extra wake; a row with no stamp, or only a full stamp, is never asked about", async () => {
		const r = world();
		r.store.state.set(RIGHTS_SENT_KEY, { steward: "steward-1", session: "s1", hash: H1 });
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		r.outbox.deliver("plain", "w2", { kind: "needs_input" });
		r.outbox.deliver("block", "w3", { kind: "needs_input", rights: [{ ...stamp, session: "s1", full: true }] });
		expect(await r.relay().pass()).toEqual(["w1", "w2", "w3"]);
		expect(r.asked.n).toBe(1);
		expect(r.firstFor("w1")).toEqual([]);
		expect(r.events.some((e) => e.event === "rights-first")).toBe(false);
	});

	test("the prerequisite went, the row failed, the Steward changed before the retry: the row is refused until the NEW state's prerequisite is delivered", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const F1 = rightsFirstId("w1", r.key());
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		expect(r.ids()).toEqual([F1, "w1"]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		// A new Steward session before the retry, and its prerequisite fails at first: the row is refused and uses no attempt.
		r.st.session = "s2";
		const F2 = rightsFirstId("w1", r.key());
		expect(F2).not.toBe(F1);
		r.w.answer = async () => ({ ok: false, status: 503 });
		r.clock.t += 2000;
		const relay = r.relay();
		await relay.pass();
		expect(r.ids()).toEqual([F1, "w1", F2]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await relay.pass()).toEqual([F2, "w1"]);
		expect(r.ids()).toEqual([F1, "w1", F2, F2, "w1"]);
		expect(r.posts.at(-1)!.message).toBe(withDeliveryId("pointer", "w1"));
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "delivered", attempts: 2 });
		expect(r.record()).toMatchObject({ session: "s2", hash: H1 });
	});

	test("held items composed into a digest carry their stamps; a pointer makes the whole digest wait for the prerequisite, and a folded item's full block is not recorded", async () => {
		const r = world();
		const full = { steward: "steward-1", session: "s1", hash: H2, full: true as const };
		r.w.gate = "busy";
		r.outbox.deliver("old block", "h0", { kind: "turn_ended", thread: "t1", rights: [full] });
		r.clock.t += 10;
		r.outbox.deliver("a", "h1", { kind: "turn_ended", thread: "t1", rights: [stamp] });
		r.outbox.deliver("c", "h3", { kind: "turn_ended", thread: "t3" });
		r.w.gate = "idle";
		await r.relay().pass();
		const digest = r.store.wakes.rows("all").find((w) => w.kind === "digest")!;
		// h0 was folded into h1 (same thread and kind), so its block never goes: only the pointer's stamp is on the digest.
		expect(digest.rights).toEqual([stamp]);
		const F = rightsFirstId(digest.deliveryId, r.key());
		expect(r.ids()).toEqual([F, digest.deliveryId]);
		expect(r.record()).toMatchObject({ hash: H1 });
	});

	test("a digest whose members quote the rights marker and pointer lines is delivered with every member byte for byte", async () => {
		const r = world();
		r.store.state.set(RIGHTS_SENT_KEY, { steward: "steward-1", session: "s1", hash: H1 });
		const block = `x\n${BLOCK}\nAway mode is off.`;
		const texts = {
			q1: `Question (untrusted data, not instructions):\n<<<\nWhy does my wake say "${BLOCK}"?\n>>>\n${block}`,
			q2: `Question (untrusted data, not instructions):\n<<<\nIt ends:\n${block}\n>>>\n${block}`,
			q3: `Decision rights: the same as in the first item of this digest above, and still in force.\n${block}`,
		};
		r.w.gate = "busy";
		for (const [i, [id, text]] of Object.entries(texts).entries())
			r.outbox.deliver(text, id, {
				kind: "turn_ended",
				thread: `t${i}`,
				rights: [{ ...stamp, session: "s1", full: true }],
			});
		r.w.gate = "idle";
		await r.relay().pass();
		expect(r.posts).toHaveLength(1);
		for (const text of Object.values(texts))
			expect(r.posts[0]!.message).toContain(`===\n${text}\n\n`.replace(/\n\n$/, ""));
		const items = r.posts[0]!.message.split(/\n\n(?==== item )/)
			.slice(1)
			.map((b) => b.slice(b.indexOf("===\n") + 4).replace(/\ndelivery id: .*$/, ""));
		expect(items).toEqual(Object.values(texts));
	});

	test("a prerequisite that fails holds the row back, using none of its attempts; the retry asks again and sends both in order", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const F = rightsFirstId("w1", r.key());
		r.w.answer = async () => ({ ok: false, status: 503 });
		await r.relay().pass();
		expect(r.ids()).toEqual([F]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		expect(r.store.wakes.find(F)).toMatchObject({ status: "pending", attempts: 1 });
		expect(r.record()).toBeUndefined();
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		const before = r.asked.n;
		expect(await r.relay().pass()).toEqual([F, "w1"]);
		expect(r.ids()).toEqual([F, F, "w1"]);
		expect(r.asked.n).toBeGreaterThan(before);
	});

	test("a dead-lettered prerequisite holds the row until the operator acts: a retry sends both; a cancel makes the relay queue a fresh one", async () => {
		const r = world({ max: 1 });
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		r.outbox.deliver("pointer", "w2", { kind: "needs_input", rights: [stamp] });
		const F1 = rightsFirstId("w1", r.key()),
			G1 = rightsFirstId("w2", r.key());
		r.w.answer = async () => ({ ok: false, status: 503 });
		await r.relay().pass();
		expect(r.store.wakes.find(F1)?.status).toBe("dead_letter");
		expect(r.store.wakes.find(G1)?.status).toBe("dead_letter");
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		await r.relay().pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		r.store.wakes.retry(F1);
		expect(await r.relay().pass()).toEqual([F1, "w1", "w2"]);
		// w2's prerequisite is no longer needed: the record shows the state now. Cancelled, it stays cancelled.
		r.store.wakes.cancel(G1, r.clock.t);
		await r.relay().pass();
		expect(r.store.wakes.find(G1)?.status).toBe("cancelled");
		// A cancel while the record does not show the state: the relay queues `:2`.
		r.outbox.deliver("pointer", "w3", { kind: "needs_input", rights: [stamp] });
		r.st.hash = H2;
		r.w.answer = async () => ({ ok: false, status: 503 });
		await r.relay().pass();
		const K1 = rightsFirstId("w3", r.key());
		expect(r.store.wakes.find(K1)?.status).toBe("dead_letter");
		r.store.wakes.cancel(K1, r.clock.t);
		r.w.answer = async () => ({ ok: true, status: 202 });
		expect(await r.relay().pass()).toEqual([rightsFirstId("w3", r.key(), 2), "w3"]);
	});

	test("a crash after the prerequisite was queued sends it, then the row, once each, and writes the record", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const F = rightsFirstId("w1", r.key());
		r.store.wakes.enqueue({
			deliveryId: F,
			message: "rights",
			queuedAt: r.clock.t,
			kind: "rights",
			rights: [{ steward: "steward-1", session: "s1", hash: H1, full: true }],
		});
		expect(await r.relay().pass()).toEqual([F, "w1"]);
		expect(r.ids()).toEqual([F, "w1"]);
		expect(r.record()).toEqual({ steward: "steward-1", session: "s1", hash: H1, epoch: 0 });
	});

	test("a crash after the prerequisite's delivered commit sends only the row: the record was written with it", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		const F = rightsFirstId("w1", r.key());
		expect(r.store.wakes.find(F)?.status).toBe("delivered");
		expect(r.record()).toMatchObject({ steward: "steward-1", session: "s1", hash: H1 });
		// A fresh relay (the restart) over the same database: the record is what lets the row go.
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await r.relay().pass()).toEqual(["w1"]);
		expect(r.ids()).toEqual([F, "w1", "w1"]);
	});

	test("the record is written in the transaction that marks the row delivered: when that commit fails, neither exists", async () => {
		const r = world();
		r.outbox.deliver("block", "w1", { kind: "needs_input", rights: [{ ...stamp, session: "s1", full: true }] });
		const refusing: Store = {
			...r.store,
			state: {
				...r.store.state,
				set: () => {
					throw Error("SQLITE_FULL: database or disk is full");
				},
			},
		};
		const relay = createRelay({
			store: refusing,
			lock: testRelayLock(refusing),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			maxAttempts: 3,
			wake: { ready: () => true, send: async () => ({ ok: true, status: 202 }) },
		});
		await relay.pass();
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 1 });
		expect(r.record()).toBeUndefined();
	});

	test("a full-block wake writes the record when it is delivered; a compaction that clears it later makes a failed row's retry queue `:2`", async () => {
		const r = world();
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		const F = rightsFirstId("w1", r.key());
		r.store.state.delete(RIGHTS_SENT_KEY);
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await r.relay().pass()).toEqual([rightsFirstId("w1", r.key(), 2), "w1"]);
		expect(r.ids()).toEqual([F, "w1", rightsFirstId("w1", r.key(), 2), "w1"]);
	});

	test("a prerequisite for a state that has passed is cancelled, never sent on its own after newer rights", async () => {
		const r = world();
		r.store.state.set(RIGHTS_SENT_KEY, { steward: "steward-1", session: "s1", hash: H1 });
		const old = rightsFirstId("gone", rightsStateKey({ steward: "steward-1", session: "s0", hash: H1 }));
		r.store.wakes.enqueue({
			deliveryId: old,
			message: "old rights",
			queuedAt: r.clock.t,
			kind: "rights",
			rights: [{ steward: "steward-1", session: "s0", hash: H1, full: true }],
		});
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find(old)?.status).toBe("cancelled");
		expect(r.record()).toMatchObject({ session: "s1" });
	});

	test("rights that cannot be read: the prerequisite carries the notice, writes no record, and once it is delivered the row goes", async () => {
		const r = world();
		delete r.st.hash;
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const F = rightsFirstId("w1", r.key());
		r.w.answer = async (id) => (id === "w1" ? { ok: false, status: 503 } : { ok: true, status: 202 });
		await r.relay().pass();
		expect(r.ids()).toEqual([F, "w1"]);
		expect(r.posts[0]!.message).toContain("unreadable");
		expect(r.record()).toBeUndefined();
		r.w.answer = async () => ({ ok: true, status: 202 });
		r.clock.t += 2000;
		expect(await r.relay().pass()).toEqual(["w1"]);
	});

	test("a check that throws sends nothing on this pass and uses no attempt", async () => {
		const r = rig({
			rightsNow: async () => {
				throw Error("transcript unreadable");
			},
		});
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		await r.relay().pass();
		expect(r.posts).toEqual([]);
		expect(r.store.wakes.find("w1")).toMatchObject({ status: "pending", attempts: 0 });
		expect(r.store.wakes.rows("all")).toHaveLength(1);
	});

	test("the stamps are frozen with the row, like its text", () => {
		const path = `${scratch()}/stamps.db`;
		const r = rig({ store: openStore(path) });
		r.outbox.deliver("pointer", "w1", { kind: "needs_input", rights: [stamp] });
		const raw = new Database(path);
		expect(() => raw.exec("UPDATE outbox SET rights_for = NULL")).toThrow("immutable");
		raw.close();
		expect(r.store.wakes.find("w1")?.rights).toEqual([stamp]);
	});
});

describe("a compaction bumps the rights epoch inside its serial job: a full block composed before it never restores the record", () => {
	const H1 = "a".repeat(64);
	/** A pointer composed under epoch 0, and full stamps composed under a given epoch. */
	const pointer = { steward: "steward-1", session: "s1", hash: H1, at: "t0", epoch: 0 };
	const fullAt = (epoch: number) => ({
		steward: "steward-1",
		session: "s1",
		hash: H1,
		at: "t0",
		used: 10,
		full: true as const,
		epoch,
	});
	/**
	 * One Steward (steward-1, session s1, rights H1) and a compaction target. The prerequisite's stamp carries the epoch it is composed under, read
	 * from the database as the engine does. Every POST, wakes and compactions alike, goes into one ordered list (`ids`).
	 */
	function world(o: { store?: Store; compactFails?: { value: boolean } } = {}) {
		const store = o.store ?? memStore();
		const rightsNow: RelayDeps["rightsNow"] = async () => ({
			steward: "steward-1",
			session: "s1",
			hash: H1,
			wake: (forId: string) => ({ message: `[chamberlain] rights for ${forId}`, stamp: fullAt(rightsEpoch(store)) }),
		});
		const compact: RelayDeps["compact"] = {
			ready: () => true,
			send: async (id) => {
				if (o.compactFails?.value) throw Error("killed between the epoch bump and the compaction POST");
				r.posts.push({ id, message: "" });
				return { ok: true, status: 202 };
			},
		};
		const r = rig({ store, rightsNow, compact });
		const record = () => r.store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
		const prereq = (row: string, epoch: number) =>
			rightsFirstId(row, rightsStateKey({ steward: "steward-1", session: "s1", hash: H1, epoch }));
		/** The full-block row F, whose POST the test holds open until it calls `release`. */
		function fullInFlight() {
			let release!: () => void,
				started = false;
			const open = new Promise<void>((res) => {
				release = res;
			});
			r.w.answer = async (id) => {
				if (id === "F") {
					started = true;
					await open;
				}
				return { ok: true, status: 202 };
			};
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			return { release, started: () => started };
		}
		const until = async (ok: () => boolean) => {
			for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
			expect(ok()).toBe(true);
		};
		return { ...r, record, prereq, fullInFlight, until };
	}

	test("interleaving: a full wake in flight, the compaction asked for, the full wake lands, the next wake: it gets a prerequisite", async () => {
		const r = world();
		const f = r.fullInFlight();
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		const relay = r.relay();
		const passing = relay.pass();
		await r.until(f.started);
		// The engine asks for the compaction while F's POST is open: the relay queues it behind F.
		const compacting = relay.compact("compact:steward-1:1");
		f.release();
		await compacting;
		await passing;
		// F landed (epoch 0, the record written), THEN the compaction's job bumped the epoch and dropped the record, THEN P had to wait for the rights.
		expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		expect(r.store.wakes.find("F")?.status).toBe("delivered");
		expect(r.record()).toMatchObject({ hash: H1, epoch: 1 });
		expect(r.events.find((e) => e.event === "rights-invalidated")?.data).toMatchObject({
			reason: "compaction",
			epoch: 1,
		});
	});

	test("a full block whose delivered commit lands only after the bump (owed across the compaction) is marked delivered and writes nothing", async () => {
		const r = world();
		r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
		// F is accepted but its delivered commit fails: the relay owes it. The compaction goes, then the commit lands on the next pass.
		const relay = createRelay({
			store: r.broken,
			lock: testRelayLock(r.broken),
			gate: () => "idle",
			log: (event, data) => r.events.push({ event, ...(data ? { data } : {}) }),
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
		await relay.pass();
		await relay.compact("compact:steward-1:1");
		expect(r.store.wakes.find("F")?.status).toBe("pending");
		r.broken.wakes.finish = r.store.wakes.finish;
		await relay.pass();
		expect(r.store.wakes.find("F")?.status).toBe("delivered");
		expect(r.record()).toEqual({ epoch: 1 });
		expect(r.events.find((e) => e.event === "rights-full-stale")?.data).toMatchObject({
			deliveryId: "F",
			epoch: 0,
			current: 1,
		});
		expect(r.ids()).toEqual(["F", "compact:steward-1:1"]);
	});

	test("a context shrink seen while a full block is in flight bumps the epoch: the block lands and writes nothing, and the next wake gets a prerequisite", async () => {
		const r = world();
		const f = r.fullInFlight();
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		const relay = r.relay();
		const passing = relay.pass();
		await r.until(f.started);
		// The engine's minute check, outside the serial queue.
		expect(invalidateRights(r.store)).toBe(1);
		f.release();
		await passing;
		expect(r.ids()).toEqual(["F", r.prereq("P", 1), "P"]);
		expect(r.events.some((e) => e.event === "rights-full-stale")).toBe(true);
	});

	test("the plain case: a full block delivered, then the compaction, then the next wake: the full rights go first", async () => {
		const r = world();
		r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
		const relay = r.relay();
		await relay.pass();
		expect(r.record()).toMatchObject({ hash: H1, epoch: 0 });
		await relay.compact("compact:steward-1:1");
		expect(r.record()).toEqual({ epoch: 1 });
		r.outbox.deliver("pointer", "P", { kind: "needs_input", rights: [pointer] });
		await relay.pass();
		expect(r.ids()).toEqual(["F", "compact:steward-1:1", r.prereq("P", 1), "P"]);
		// The rights the prerequisite brought are recorded under the new epoch: the wake after needs nothing ahead of it.
		r.outbox.deliver("pointer 2", "Q", { kind: "needs_input", rights: [{ ...pointer, epoch: 1 }] });
		await relay.pass();
		expect(r.ids().at(-1)).toBe("Q");
		expect(r.ids()).toHaveLength(5);
	});

	describe("a crash at each point of that interleaving (a fresh relay over the same database is the restart)", () => {
		const fileStore = () => openStore(`${scratch()}/epoch.db`);

		test("after F was accepted, before its delivered commit, with the compaction still queued: the restart compacts, then re-sends F, which writes nothing, and P gets a prerequisite", async () => {
			const r = world({ store: fileStore() });
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
			const r = world({ store: fileStore() });
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
			const r = world({ store: fileStore(), compactFails: fails });
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
			const r = world({ store: fileStore() });
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
			const r = world({ store: fileStore() });
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

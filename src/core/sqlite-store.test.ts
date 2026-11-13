import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { repeatAtIntervals, NOTIFY_ONCE, repeatEvery } from "./notification.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { DatabaseTooNewError, openStore } from "./sqlite-store.ts";
import type { Challenge, Store } from "./store.ts";

const open: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of open.splice(0)) { try { s.close(); } catch { /* closed */ } }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mem = () => { const s = openStore(":memory:"); open.push(s); return s; };
const file = () => { const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`); dirs.push(d); const path = `${d}/chamberlain.db`; const s = openStore(path); open.push(s); return { s, path, d }; };
const raw = (path: string) => new Database(path);

describe("opening the database", () => {
	test("a file database is private, in WAL mode, with foreign keys on and a busy timeout", () => {
		const { path } = file();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const db = raw(path);
		expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
		db.close();
		const s = openStore(path);
		open.push(s);
		// The connection's own pragmas: a second handle sees them set.
		expect(() => s.claims.claim("queue", { owner: "page", item: "Q-none", deliveryId: "d", message: "m", t: "t" })).toThrow(/no item/);
	});

	test("migrations are recorded, and reopening applies nothing twice", () => {
		const { s, path } = file();
		s.close();
		const again = openStore(path);
		open.push(again);
		const db = raw(path);
		expect(db.query("SELECT version, name FROM migrations ORDER BY version").all()).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
		db.close();
	});

	test("a v0.1.1 database (migrations 1 to 7) upgrades in place: its wakes keep going to the Steward", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v0.1.1.db`;
		const db = raw(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 7)) { db.exec(m.sql); db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name); }
		db.exec(`INSERT INTO outbox (id, delivery_id, message, created_at) VALUES (1, 'w1', 'm', 1);
			INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES ('w1', 1, 1);
			INSERT INTO held_wakes (delivery_id, message, queued_at, kind) VALUES ('h1', 'held', 2, 'turn');`);
		db.close();
		const s = openStore(path);
		open.push(s);
		const after = raw(path);
		expect((after.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(LATEST_MIGRATION);
		after.close();
		expect(s.wakes.rows("pending", null).map((r) => r.deliveryId)).toEqual(["w1"]);
		expect(s.wakes.held(null).map((h) => h.deliveryId)).toEqual(["h1"]);
		expect(s.wakes.rows("pending", "desk")).toEqual([]);
	});

	test("an upgrade marks every undelivered, unstamped Steward wake legacy whatever its text, and never touches the text", () => {
		const OLD = "Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";
		const legacy = [{ hash: "", legacy: "unstamped" as const }];
		for (const version of [7, 8, 9]) {
			const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
			dirs.push(d);
			const path = `${d}/v${version}.db`;
			const db = raw(path);
			db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
			for (const m of MIGRATIONS.filter((x) => x.version <= version)) { db.exec(m.sql); db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name); }
			const rows: [string, string, string][] = [["p1", `a\n${OLD}\nb`, "pending"], ["plain", "Decision rights (standing rules):\nmerge green PRs", "pending"], ["dl", "x", "dead_letter"], ["done", `x\n${OLD}`, "delivered"], ["gone", `x\n${OLD}`, "cancelled"]];
			rows.forEach(([id, message, status], i) => {
				db.query("INSERT INTO outbox (id, delivery_id, message, created_at, status) VALUES (?, ?, ?, 1, ?)").run(i + 1, id, message, status);
				db.query("INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES (?, ?, 1)").run(id, i + 1);
			});
			db.exec("INSERT INTO held_wakes (delivery_id, message, queued_at, kind) VALUES ('h-plain', 'held', 2, 'turn')");
			// From schema 8, a wake can be for another receiver (the desk): never the Steward's, so never marked.
			if (version >= 8) {
				db.query("INSERT INTO outbox (id, delivery_id, message, created_at, status, receiver) VALUES (9, 'desk-row', ?, 1, 'pending', 'desk')").run(`x\n${OLD}`);
				db.query("INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES ('desk-row', 9, 1)").run();
				db.exec("INSERT INTO held_wakes (delivery_id, message, queued_at, kind, receiver) VALUES ('h-desk', 'held', 2, 'turn', 'desk')");
			}
			db.close();
			const s = openStore(path);
			open.push(s);
			const stamps = (id: string) => s.wakes.find(id)?.rights;
			expect([stamps("p1"), stamps("plain"), stamps("dl")]).toEqual([legacy, legacy, legacy]);
			expect([stamps("done"), stamps("gone"), stamps("desk-row")]).toEqual([undefined, undefined, undefined]);
			expect(Object.fromEntries(s.wakes.held().map((h) => [h.deliveryId, h.rights]))).toEqual({ "h-plain": legacy, ...(version >= 8 ? { "h-desk": undefined } : {}) });
			// The text itself is never touched: rows stay immutable, only the stamp column is set, and the freeze trigger is back.
			expect(s.wakes.find("p1")?.message).toBe(`a\n${OLD}\nb`);
			const after = raw(path);
			expect(() => after.exec("UPDATE outbox SET rights_for = NULL WHERE delivery_id = 'p1'")).toThrow("immutable");
			after.close();
		}
	});

	test("a database already at migration 9 keeps its stamps: a stamped pointer is not re-marked", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v9.db`;
		const db = raw(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 9)) { db.exec(m.sql); db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name); }
		const stamp = [{ steward: "s1", session: "x", hash: "h", at: "2026-11-13T18:00:00.000Z" }];
		db.query("INSERT INTO outbox (id, delivery_id, message, created_at, rights_for) VALUES (1, 'w', ?, 1, ?)").run("Decision rights and rulings unchanged since 2026-11-13T18:00:00.000Z and still in force; your hand-off (steward-brief.md) has them.", JSON.stringify(stamp));
		db.close();
		const s = openStore(path);
		open.push(s);
		expect(s.wakes.find("w")?.rights).toEqual(stamp);
	});

	test("a database newer than this build is refused with a clear error", () => {
		const { s, path } = file();
		s.close();
		const db = raw(path);
		db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, 'from the future', 'now')").run(LATEST_MIGRATION + 1);
		db.close();
		expect(() => openStore(path)).toThrow(DatabaseTooNewError);
		expect(() => openStore(path)).toThrow(new RegExp(`migration ${LATEST_MIGRATION + 1}.*understands up to ${LATEST_MIGRATION}.*newer Chamberlain`));
	});

	test("foreign keys are enforced: a row cannot point at an item that does not exist", () => {
		const { s, path } = file();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-a1b2c3" });
		s.close();
		const t = openStore(path);
		open.push(t);
		expect(() => t.evidence.put("queue", "Q-missing", [])).toThrow(/no item/);
	});
});

describe("transactions", () => {
	test("a throw rolls back everything the function did, and nested ones roll back alone", () => {
		const s = mem();
		expect(() => s.tx(() => { s.state.set("a", 1); throw Error("boom"); })).toThrow("boom");
		expect(s.state.get("a")).toBeUndefined();
		s.tx(() => {
			s.state.set("outer", 1);
			expect(() => s.tx(() => { s.state.set("inner", 1); throw Error("no"); })).toThrow("no");
			s.state.set("after", 1);
		});
		expect([s.state.get("outer"), s.state.get("inner"), s.state.get("after")]).toEqual([1, undefined, 1]);
	});

	test("a function that awaits is refused, since a transaction cannot span a tick", () => {
		const s = mem();
		expect(() => s.tx(() => Promise.resolve(1) as unknown as number)).toThrow(/cannot await/);
		expect(s.state.get("x")).toBeUndefined();
	});
});

describe("items: observe, the repeat policy and the lifecycle", () => {
	const obs = (s: Store, o: Partial<Parameters<Store["items"]["observe"]>[0]> = {}) => s.items.observe({ source: "sweep:disk", kind: "finding", dedupKey: "disk-low", ...o });

	test("a new item is triggered, notifies once under the default policy, and a second sighting does not notify again", () => {
		const s = mem();
		const a = obs(s, { now: 100, subject: { kind: "pr", id: "42" }, payload: { text: "disk" } });
		expect(a).toMatchObject({ created: true, notify: true, wouldNotify: false });
		expect(a.item).toMatchObject({ status: "triggered", mode: "live", firstSeen: 100, lastSeen: 100, notificationCount: 1, nextNotificationAt: null, subject: { kind: "pr", id: "42" }, payload: { text: "disk" } });
		const b = obs(s, { now: 200 });
		expect(b).toMatchObject({ created: false, notify: false });
		expect(b.item).toMatchObject({ firstSeen: 100, lastSeen: 200, notificationCount: 1, payload: { text: "disk" } });
	});

	test("(source, dedup key) is unique: the same dedup key in another source is another item", () => {
		const s = mem();
		obs(s, { now: 1 });
		obs(s, { source: "sweep:net", now: 1 });
		expect(s.items.list()).toHaveLength(2);
		obs(s, { now: 2 });
		expect(s.items.list()).toHaveLength(2);
	});

	test("a repeating item notifies again when its time comes, up to the maximum", () => {
		const s = mem();
		const policy = repeatAtIntervals([1000], 3);
		const sent = [0, 500, 1000, 1500, 2000, 3000, 4000].map((now) => obs(s, { repeat: policy, now }).notify);
		expect(sent).toEqual([true, false, true, false, true, false, false]);
		expect(s.items.get("sweep:disk", "disk-low")).toMatchObject({ notificationCount: 3, nextNotificationAt: null });
	});

	test("a baseline item is learned silently, and stays quiet until it goes away and comes back", () => {
		const s = mem();
		const r = obs(s, { baseline: true, repeat: repeatEvery(0), now: 1 });
		expect(r).toMatchObject({ created: true, notify: false });
		expect(r.item.status).toBe("acknowledged");
		expect(obs(s, { repeat: repeatEvery(0), now: 2 }).notify).toBe(false);
		s.items.resolveAbsent("sweep:disk", "finding", [], 3);
		expect(s.items.get("sweep:disk", "disk-low")?.status).toBe("resolved");
		const back = obs(s, { repeat: NOTIFY_ONCE, now: 4 });
		expect(back).toMatchObject({ reopened: true, notify: true });
		expect(back.item).toMatchObject({ firstSeen: 4, notificationCount: 1, resolvedAt: null });
	});

	test("resolveAbsent resolves only what is missing, in its source and kind", () => {
		const s = mem();
		for (const key of ["a", "b", "c"]) obs(s, { dedupKey: key, now: 1 });
		s.items.observe({ source: "sweep:disk", kind: "other", dedupKey: "z", now: 1 });
		const gone = s.items.resolveAbsent("sweep:disk", "finding", ["b"], 5);
		expect(gone.map((i) => i.dedupKey)).toEqual(["a", "c"]);
		expect(s.items.list({ status: "resolved" }).map((i) => i.dedupKey)).toEqual(["a", "c"]);
		expect(s.items.get("sweep:disk", "z")?.status).not.toBe("resolved");
	});

	test("shadow mode records would-be notifications apart from live ones, so going live starts from a true zero", () => {
		const s = mem();
		const policy = repeatEvery(1000);
		expect(obs(s, { mode: "shadow", repeat: policy, now: 0 })).toMatchObject({ notify: false, wouldNotify: true });
		expect(obs(s, { mode: "shadow", repeat: policy, now: 1000 })).toMatchObject({ notify: false, wouldNotify: true });
		const logged = s.items.get("sweep:disk", "disk-low")!;
		expect(logged).toMatchObject({ status: "triggered", notificationCount: 0, nextNotificationAt: null, shadowNotificationCount: 2 });
		// Going live: the first real notification is count 1 now, not a continuation of two would-be ones.
		const live = obs(s, { mode: "live", repeat: policy, now: 1100 });
		expect(live).toMatchObject({ notify: true, wouldNotify: false });
		expect(live.item).toMatchObject({ status: "triggered", notificationCount: 1, shadowNotificationCount: 2 });
	});

	test("mode silenced tracks the item and never notifies or would-notify", () => {
		const s = mem();
		expect(obs(s, { mode: "silenced", now: 1 })).toMatchObject({ notify: false, wouldNotify: false, item: { notificationCount: 0, shadowNotificationCount: 0 } });
		expect(obs(s, { mode: "silenced", now: 2 }).item.lastSeen).toBe(2);
	});

	test("acknowledge, resolve and patch change state and payload only, never the notification columns", () => {
		const s = mem();
		obs(s, { repeat: repeatEvery(10), now: 0, payload: { a: 1 } });
		expect(s.items.acknowledge("sweep:disk", "disk-low", 5, { note: "seen" })?.status).toBe("acknowledged");
		expect(obs(s, { repeat: repeatEvery(10), now: 50 }).notify).toBe(false);
		expect(s.items.patch("sweep:disk", "disk-low", { b: 2 })?.payload).toEqual({ a: 1, note: "seen", b: 2 });
		const done = s.items.resolve("sweep:disk", "disk-low", 60, { how: "fixed" })!;
		expect(done).toMatchObject({ status: "resolved", resolvedAt: 60, notificationCount: 1, payload: { a: 1, note: "seen", b: 2, how: "fixed" } });
		expect(s.items.resolve("sweep:disk", "disk-low", 99)?.resolvedAt).toBe(60);
		expect(s.items.resolve("sweep:disk", "nope")).toBeUndefined();
	});

	test("prune deletes old resolved items, but not the queue's", () => {
		const s = mem();
		for (const source of ["sweep:x", "queue"]) { s.items.observe({ source, kind: "k", dedupKey: "a", now: 1 }); s.items.resolve(source, "a", 2); }
		s.items.observe({ source: "sweep:x", kind: "k", dedupKey: "live", now: 1 });
		expect(s.items.prune(1000)).toBe(1);
		expect(s.items.list().map((i) => `${i.source}/${i.dedupKey}`)).toEqual(["queue/a", "sweep:x/live"]);
	});

	test("list filters by source, kind, status and subject", () => {
		const s = mem();
		s.items.observe({ source: "a", kind: "finding", dedupKey: "1", subject: { kind: "pr", id: "7" } });
		s.items.observe({ source: "a", kind: "alarm", dedupKey: "2" });
		s.items.observe({ source: "b", kind: "finding", dedupKey: "3", subject: { kind: "pr", id: "7" } });
		expect(s.items.list({ source: "a" })).toHaveLength(2);
		expect(s.items.list({ kind: "finding" })).toHaveLength(2);
		expect(s.items.list({ subject: { kind: "pr", id: "7" } }).map((i) => i.dedupKey)).toEqual(["1", "3"]);
		expect(s.items.list({ status: ["triggered"] })).toHaveLength(3);
		expect(s.items.list({ status: "resolved" })).toHaveLength(0);
	});
});

describe("claims: the one-wake ledger", () => {
	const claim = (o: Partial<Parameters<Store["claims"]["claim"]>[1]> = {}) => ({ owner: "page", item: "Q-aaaa1", deliveryId: "answer:item:Q-aaaa1", message: "the wake", t: "2026-11-12T10:00:00.000Z", answer: { choice: 0 }, ...o });

	test("the first claim wins and the item itself is untouched; every later claimant gets the winner's back", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1", mode: "silenced" });
		const first = s.claims.claim("queue", claim());
		const second = s.claims.claim("queue", claim({ owner: "daemon", deliveryId: "other", message: "another" }));
		expect(first.won).toBe(true);
		expect(second).toMatchObject({ won: false, claim: { owner: "page", deliveryId: "answer:item:Q-aaaa1", message: "the wake", answer: { choice: 0 } } });
		expect(s.items.get("queue", "Q-aaaa1")?.status).toBe("triggered");
		expect(s.claims.get("queue", "Q-aaaa1")?.message).toBe("the wake");
		expect(s.claims.list("queue")).toHaveLength(1);
	});

	test("a delivery id taken by another item is an error, never a quietly lost claim", () => {
		const s = mem();
		for (const k of ["Q-aaaa1", "Q-bbbb2"]) s.items.observe({ source: "queue", kind: "question", dedupKey: k, mode: "silenced" });
		s.claims.claim("queue", claim());
		expect(() => s.claims.claim("queue", claim({ item: "Q-bbbb2" }))).toThrow(/UNIQUE/);
		expect(s.claims.get("queue", "Q-bbbb2")).toBeUndefined();
		expect(s.items.get("queue", "Q-bbbb2")?.status).toBe("triggered");
	});

	test("a claim made inside a transaction that rolls back leaves no claim", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1", mode: "silenced" });
		expect(() => s.tx(() => { s.claims.claim("queue", claim()); throw Error("crash before commit"); })).toThrow();
		expect(s.claims.get("queue", "Q-aaaa1")).toBeUndefined();
		expect(s.items.get("queue", "Q-aaaa1")?.status).toBe("triggered");
	});

	test("the direct send is taken once, ever, and records how it ended", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1" });
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toEqual({ started: false });
		expect(s.claims.startRelay("queue", "Q-aaaa1")).toBe(true);
		expect(s.claims.startRelay("queue", "Q-aaaa1")).toBe(false);
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toEqual({ started: true });
		s.claims.finishRelay("queue", "Q-aaaa1", "delivered", "ok");
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toMatchObject({ started: true, outcome: "delivered", detail: "ok" });
		expect(s.claims.listRelays("queue").get("Q-aaaa1")?.t).toBeTruthy();
	});

	test("evidence rows point at files and come back in order", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1" });
		s.evidence.put("queue", "Q-aaaa1", [{ type: "image", name: "a.png", caption: "before" }, { type: "link", url: "https://example.com/x" }]);
		expect(s.evidence.list("queue", "Q-aaaa1")).toEqual([{ type: "image", name: "a.png", caption: "before" }, { type: "link", url: "https://example.com/x" }]);
		s.evidence.put("queue", "Q-aaaa1", []);
		expect(s.evidence.list("queue", "Q-aaaa1")).toEqual([]);
	});
});

describe("wakes: the outbox and the held store", () => {
	test("enqueue binds the row's own id; hold keeps an item unbound; either refuses an id that is held or bound to any row", () => {
		const s = mem();
		expect(s.wakes.enqueue({ deliveryId: "a", message: "m", queuedAt: 1, kind: "turn_ended", thread: "t" })).toBe(true);
		expect(s.wakes.enqueue({ deliveryId: "a", message: "other", queuedAt: 2 })).toBe(false);
		expect(s.wakes.hold({ deliveryId: "a", message: "m", queuedAt: 2 })).toBe(false);
		expect(s.wakes.hold({ deliveryId: "h1", message: "m", queuedAt: 3, kind: "sweep" })).toBe(true);
		expect(s.wakes.enqueue({ deliveryId: "h1", message: "m", queuedAt: 3 })).toBe(false);
		expect(s.wakes.rows()).toMatchObject([{ deliveryId: "a", message: "m", kind: "turn_ended", thread: "t", status: "pending", attempts: 0, members: [{ deliveryId: "a", queuedAt: 1, kind: "turn_ended", thread: "t" }] }]);
		expect(s.wakes.held()).toEqual([{ deliveryId: "h1", message: "m", queuedAt: 3, kind: "sweep" }]);
		expect([s.wakes.known("a"), s.wakes.known("h1"), s.wakes.known("nope")]).toEqual([true, true, false]);
	});

	test("compose freezes one row from the held items in one transaction; a compose that throws leaves them held", () => {
		const s = mem();
		s.wakes.hold({ deliveryId: "h1", message: "a", queuedAt: 1 });
		s.wakes.hold({ deliveryId: "h2", message: "b", queuedAt: 2 });
		expect(() => s.wakes.compose(5, () => { throw Error("crash"); })).toThrow();
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["h1", "h2"]);
		const row = s.wakes.compose(5, (held) => ({ deliveryId: "digest:x", message: held.map((h) => h.message).join("+"), folded: 0, members: held.map((h) => h.deliveryId), kind: "digest" }))!;
		expect(row).toMatchObject({ deliveryId: "digest:x", message: "a+b", createdAt: 5, status: "pending" });
		expect(row.members.map((m) => m.deliveryId)).toEqual(["h1", "h2"]);
		expect(s.wakes.held()).toEqual([]);
		expect(s.wakes.find("h2")!.id).toBe(row.id);
		expect(s.wakes.compose(6, () => { throw Error("never called"); })).toBeUndefined();
	});

	test("attempts count only on a pending row; finish, retry and cancel move only the states they name", () => {
		const s = mem();
		s.wakes.enqueue({ deliveryId: "a", message: "m", queuedAt: 1 });
		const id = s.wakes.find("a")!.id;
		expect([s.wakes.beginAttempt(id, 2), s.wakes.beginAttempt(id, 3)]).toEqual([1, 2]);
		expect(s.wakes.retry("a")).toBe("pending");
		expect(s.wakes.find("a")!.attempts).toBe(2);
		expect(s.wakes.finish(id, "dead_letter", 4)).toBe(true);
		expect(s.wakes.beginAttempt(id, 5)).toBeUndefined();
		expect(s.wakes.retry("a")).toBe("dead_letter");
		expect(s.wakes.find("a")).toMatchObject({ status: "pending", attempts: 0 });
		expect(s.wakes.finish(id, "delivered", 6)).toBe(true);
		expect(s.wakes.isDelivered("a")).toBe(true);
		expect(s.wakes.finish(id, "dead_letter", 7)).toBe(false);
		expect(s.wakes.cancel("a", 8)).toBe("delivered");
		expect(s.wakes.find("a")!.status).toBe("delivered");
		expect(s.wakes.retry("nope")).toBeUndefined();
	});

	test("prune deletes delivered and cancelled rows finished before the cut, and no other", () => {
		const s = mem();
		for (const id of ["old", "new", "dead", "pending", "gone"]) s.wakes.enqueue({ deliveryId: id, message: "m", queuedAt: 1 });
		const row = (id: string) => s.wakes.find(id)!.id;
		s.wakes.finish(row("old"), "delivered", 1);
		s.wakes.finish(row("new"), "delivered", 100);
		s.wakes.finish(row("dead"), "dead_letter", 1);
		s.wakes.cancel("gone", 1);
		expect(s.wakes.prune(50)).toBe(2);
		expect(s.wakes.rows("all").map((r) => r.deliveryId)).toEqual(["new", "dead", "pending"]);
		// The rows are gone, the ids are not: a tombstone per delivered or cancelled id outlives retention.
		expect([s.wakes.known("old"), s.wakes.known("gone"), s.wakes.known("never")]).toEqual([true, true, false]);
		expect(s.wakes.isDelivered("old")).toBe(true);
		expect(s.wakes.isDelivered("gone")).toBe(false);
	});
});

describe("events, state, rulings, butlers, away, decisions", () => {
	test("the event log is queried with SQL filters and returns the line it was given", () => {
		const s = mem();
		s.events.append({ t: "2026-11-12T10:00:00.000Z", event: "fire", src: "queue-web", thread: "t1" });
		s.events.append({ t: "2026-11-12T11:00:00.000Z", event: "delivered", deliveryId: "d", queuedAt: 5 });
		s.events.append({ t: "2026-11-12T12:00:00.000Z", event: "alarm", dedupKey: "k" });
		expect(s.events.query({ events: ["delivered"] })).toEqual([{ t: "2026-11-12T11:00:00.000Z", event: "delivered", deliveryId: "d", queuedAt: 5 }]);
		expect(s.events.query({ since: "2026-11-12T10:30:00.000Z" }).map((e) => e.event)).toEqual(["delivered", "alarm"]);
		expect(s.events.query({ src: "queue-web" })[0]).toMatchObject({ event: "fire", thread: "t1" });
		expect(s.events.count({ events: ["fire", "alarm"] })).toBe(2);
		expect(s.events.query({ limit: 1 })).toHaveLength(1);
		expect(s.events.prune("2026-11-12T11:30:00.000Z")).toBe(2);
		expect(s.events.count()).toBe(1);
	});

	test("an imported event is stored once however often it is imported", () => {
		const s = mem();
		for (let i = 0; i < 3; i++) s.events.append({ t: "2026-11-12T10:00:00.000Z", event: "fire" }, "hash-1");
		expect(s.events.count()).toBe(1);
	});

	test("state is read-modify-written in one transaction, and undefined deletes", () => {
		const s = mem();
		expect(s.state.update<number>("n", (n) => (n ?? 0) + 1)).toBe(1);
		expect(s.state.update<number>("n", (n) => (n ?? 0) + 1)).toBe(2);
		expect(s.state.update("n", () => undefined)).toBeUndefined();
		expect(s.state.get("n")).toBeUndefined();
	});

	test("rulings round trip with their history, and an id is unique", () => {
		const s = mem();
		const r = { id: "R3", date: "2026-11-12", words: "w", decides: "d", source: "chat" as const, status: "in-force" as const, confirmed: true, confirmedAt: "t", history: [{ t: "t", what: "x" }] };
		s.rulings.save(r);
		s.rulings.save({ ...r, id: "R10", decides: "later" });
		s.rulings.save({ ...r, decides: "edited" });
		expect(s.rulings.list().map((x) => [x.id, x.decides])).toEqual([["R3", "edited"], ["R10", "later"]]);
		expect(s.rulings.list()[0]).toEqual({ ...r, decides: "edited" });
	});

	test("butlers: insert refuses a repeat id, stop is once", () => {
		const s = mem();
		const b = { id: "B-1", thread: "t", machine: "m", model: "x", scope: "s", started: "2026-11-12T10:00:00.000Z" };
		expect(s.butlers.insert(b)).toBe(true);
		expect(s.butlers.insert(b)).toBe(false);
		expect(s.butlers.stop("B-1", "2026-11-12T11:00:00.000Z", "done")).toBe(true);
		expect(s.butlers.stop("B-1", "later")).toBe(false);
		expect(s.butlers.get("B-1")).toEqual({ ...b, stopped: "2026-11-12T11:00:00.000Z", reason: "done" });
	});

	test("away: one current absence; entering again closes the old one, exit returns it", () => {
		const s = mem();
		expect(s.away.current()).toBeUndefined();
		s.away.enter({ enteredAt: "2026-11-12T10:00:00.000Z", words: "back at five" });
		s.away.enter({ enteredAt: "2026-11-12T11:00:00.000Z", words: "later", expectedReturn: "tomorrow", spendNote: "none" });
		expect(s.away.current()).toEqual({ enteredAt: "2026-11-12T11:00:00.000Z", words: "later", expectedReturn: "tomorrow", spendNote: "none" });
		expect(s.away.exit("x")?.words).toBe("later");
		expect(s.away.current()).toBeUndefined();
		expect(s.away.exit("y")).toBeUndefined();
	});

	test("decisions append and list with their ruling ids", () => {
		const s = mem();
		s.decisions.append({ t: "1", thread: "a", decision: "d", ruling: "R1: why", rulingIds: ["R1"], ref: null });
		s.decisions.append({ t: "2", thread: "b", decision: "e", ruling: "free text", ref: "x" });
		expect(s.decisions.list()).toEqual([{ t: "1", thread: "a", decision: "d", ruling: "R1: why", rulingIds: ["R1"], ref: null }, { t: "2", thread: "b", decision: "e", ruling: "free text", ref: "x" }]);
	});
});

describe("confirmation challenges", () => {
	const c = (over: Partial<Challenge> = {}): Challenge => ({ tokenHash: "h1", cardId: "C-1", sig: "s", choice: 0, sessionHash: "sess", issuedAt: 100, expiresAt: 160, ...over });
	const want = { cardId: "C-1", sig: "s", choice: 0, sessionHash: "sess" };
	test("consumed once, and only for exactly what it was issued for; a refusal changes nothing", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c());
		expect(s.challenges.consume("nope", want, 120)).toBe("unknown");
		for (const bad of [{ cardId: "C-2" }, { sig: "t" }, { choice: 1 }, { sessionHash: "other" }]) expect(s.challenges.consume("h1", { ...want, ...bad }, 120)).toBe("mismatch");
		expect(s.challenges.consume("h1", want, 160)).toBe("expired");
		expect(s.challenges.consume("h1", want, 159)).toBe("ok");
		expect(s.challenges.consume("h1", want, 159)).toBe("used");
	});
	test("a new challenge for the same card and session replaces the unconsumed one, but not another session's, nor a consumed one", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c());
		s.challenges.issue(c({ tokenHash: "other-session", sessionHash: "s2" }));
		s.challenges.issue(c({ tokenHash: "h2" }));
		expect(s.challenges.consume("h1", want, 120)).toBe("unknown");
		expect(s.challenges.consume("other-session", { ...want, sessionHash: "s2" }, 120)).toBe("ok");
		expect(s.challenges.consume("h2", want, 120)).toBe("ok");
		s.challenges.issue(c({ tokenHash: "h3" }));
		expect(s.challenges.consume("h2", want, 121)).toBe("used");
	});
	test("pruning removes only expired and consumed ones", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c({ tokenHash: "live", cardId: "C-live", expiresAt: 10_000 }));
		s.challenges.issue(c({ tokenHash: "dead", cardId: "C-dead", expiresAt: 50 }));
		s.challenges.issue(c({ tokenHash: "spent", cardId: "C-spent", expiresAt: 10_000 }));
		s.challenges.consume("spent", { ...want, cardId: "C-spent" }, 60);
		expect(s.challenges.prune(1000)).toBe(2);
		expect(s.challenges.consume("live", { ...want, cardId: "C-live" }, 1001)).toBe("ok");
		expect(s.challenges.consume("dead", want, 1001)).toBe("unknown");
	});
});

/**
 * Issue #76: queued-run handoffs persist across a daemon restart on the same SQLite store.
 * Ports Sol's R2-1 probe ("pending handoff survives engine restart with same persistent store").
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { HANDOFF_THREAD, handoffScenario, HANDOFF_PLAIN as PLAIN } from "../../testing/queued-run-handoff-scenario.ts";
import { NOTIFICATION_LOG } from "../items/notification.ts";
import { ITEM_KEEP_MS, maintain } from "../ops/maintain.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "../store/migrations.ts";
import { openStore } from "../store/sqlite-store.ts";
import { createEngine } from "./engine.ts";

const fixtures = useCoreEngineFixtures(createEngine);
const { rig } = fixtures;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scratchDb = () => {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-handoff-"));
	dirs.push(dir);
	return join(dir, "restart.sqlite");
};

test("handoff persist: pending handoff survives engine restart with same persistent store", async () => {
	const path = scratchDb();
	await handoffScenario(
		fixtures,
		async ({ r, state, next, runs, items, advance }) => {
			state(20);
			next();
			state(21);
			r.fake.inspect!.handoffSnapshot = async () => {
				throw Error("transient read failure");
			};
			await advance(20);
			expect(r.events.some((e) => e.event === "skip-handoff-unconfirmed")).toBe(true);
			await r.engine.stop();
			r.store.close();
			r.fake.inspect!.handoffSnapshot = async () => structuredClone({ runs, items });
			const restarted = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			state(21);
			runs[1]!.status = "completed";
			items.at(-1)!.text = "SUCCESSOR FINAL";
			state(21, "completed");
			await advance(20);
			restarted.clock.t += 31_000;
			await restarted.engine.tick();
			await advance(20);
			const all = [...r.fake.wakes.map((w) => w.message), ...restarted.held().map((w) => JSON.stringify(w))].join("\n");
			expect(all).toContain("SUCCESSOR FINAL");
			expect(all).toContain(PLAIN);
		},
		openStore(path),
	);
});

test("handoff persist: already-delivered handoff does not double-send after restart", async () => {
	const path = scratchDb();
	await handoffScenario(
		fixtures,
		async ({ r, state, next, advance }) => {
			state(20);
			next();
			state(21);
			await advance(20);
			expect(r.fake.wakes.some((w) => w.message.includes(PLAIN))).toBe(true);
			expect(r.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
			const before = r.fake.wakes.length;
			await r.engine.stop();
			r.store.close();
			const restarted = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			state(21);
			await advance(20);
			restarted.clock.t += 31_000;
			await restarted.engine.tick();
			await advance(20);
			expect(r.fake.wakes.filter((w) => w.message.includes(PLAIN))).toHaveLength(1);
			expect(r.fake.wakes.length).toBe(before);
			expect(restarted.held().filter((w) => JSON.stringify(w).includes(PLAIN))).toHaveLength(0);
		},
		openStore(path),
	);
});

test("handoff persist: rejected-human disposition survives restart and is not admitted as ordinary completion", async () => {
	const path = scratchDb();
	await handoffScenario(
		fixtures,
		async ({ r, state, next, runs, items, advance }) => {
			state(20);
			next(true);
			state(21);
			await advance(20);
			expect(r.events.some((e) => e.event === "skip-human-successor")).toBe(true);
			expect(r.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("rejected-human");
			await r.engine.stop();
			r.store.close();
			r.fake.inspect!.handoffSnapshot = async () => structuredClone({ runs, items });
			const restarted = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			expect(restarted.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("rejected-human");
			// After restart, an ordinary LIVE→completed for the same run must still see the terminal rejection.
			state(20);
			state(20, "completed");
			await advance(20);
			restarted.clock.t += 31_000;
			await restarted.engine.tick();
			await advance(20);
			const all = [...r.fake.wakes.map((w) => w.message), ...restarted.held().map((w) => JSON.stringify(w))].join("\n");
			expect(all).not.toContain(PLAIN);
			expect(restarted.events.some((e) => e.event === "skip-human-successor")).toBe(true);
		},
		openStore(path),
	);
});

/**
 * Sol R78-1: a throw while writing "confirmed" rolls back claim and wake with the confirm; a later healthy restart
 * delivers exactly once and closes the row. Includes Sol's aging step.
 */
test("crash: a throw while confirming rolls back claim and wake; restart delivers once", async () => {
	const path = scratchDb();
	const s = openStore(path);
	const original = s.handoffs.put.bind(s.handoffs);
	let blocked = false;
	s.handoffs.put = (server, h, now) => {
		if (h.disposition === "confirmed") {
			blocked = true;
			throw Error("simulated crash after claim");
		}
		original(server, h, now);
	};
	await handoffScenario(
		fixtures,
		async ({ r, state, next, advance }) => {
			state(20);
			next();
			state(21);
			await advance(20);
			expect(blocked).toBe(true);
			// Same-tx confirm: the throw aborts claim + wake + confirm together; the handoff stays pending.
			expect(s.items.get(NOTIFICATION_LOG, `${HANDOFF_THREAD}:ended:r20`)?.notificationCount ?? 0).toBe(0);
			expect(s.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("pending");
			await r.engine.stop();
			s.close();
			const restarted = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			state(21);
			await advance(20);
			restarted.clock.t += 31_000;
			await restarted.engine.tick();
			await advance(20);
			expect(r.fake.wakes.filter((w) => w.message.includes(PLAIN))).toHaveLength(1);
			expect(restarted.held().filter((w) => JSON.stringify(w).includes(PLAIN))).toHaveLength(0);
			expect(restarted.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
			await advance(ITEM_KEEP_MS + 1);
			restarted.clock.t += ITEM_KEEP_MS + 1;
			maintain(restarted.store, Date.now());
			expect(restarted.store.items.get(NOTIFICATION_LOG, `${HANDOFF_THREAD}:ended:r20`)).toBeUndefined();
			// Confirmed rows may age out with the claim; they must not remain pending (the R78-1 resend path).
			expect(restarted.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).not.toBe("pending");
			state(21);
			await advance(20);
			restarted.clock.t += 31_000;
			await restarted.engine.tick();
			await advance(20);
			expect(r.fake.wakes.filter((w) => w.message.includes(PLAIN))).toHaveLength(1);
		},
		s,
	);
});

/** Leftover claim+pending from an older build: maintain closes it before pruning the claim. */
test("crash leftover: maintain confirms claimed-pending before pruning the notification claim", () => {
	const s = openStore(":memory:");
	const key = `${HANDOFF_THREAD}:ended:r20`;
	const now = Date.now();
	s.handoffs.put(
		"fake",
		{ threadId: HANDOFF_THREAD, runId: "r20", successorId: "r21", disposition: "pending" },
		now - ITEM_KEEP_MS - 1,
	);
	s.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey: key, now: now - ITEM_KEEP_MS - 1 });
	expect(s.items.get(NOTIFICATION_LOG, key)?.notificationCount).toBe(1);
	maintain(s, now);
	expect(s.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
	expect(s.items.get(NOTIFICATION_LOG, key)).toBeUndefined();
	s.close();
});

test("handoff persist: migration 17 upgrades an existing migration-16 database", () => {
	const path = scratchDb();
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	for (const m of MIGRATIONS.filter((x) => x.version <= 16)) {
		db.exec(m.sql);
		db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
	}
	expect(
		db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='run_handoffs'").get() as {
			name: string;
		} | null,
	).toBeNull();
	db.close();
	const s = openStore(path);
	expect((s as { path: string }).path).toBe(path);
	s.handoffs.put("fake", {
		threadId: HANDOFF_THREAD,
		runId: "r1",
		successorId: "r2",
		disposition: "pending",
	});
	expect(s.handoffs.get("fake", HANDOFF_THREAD, "r1")?.disposition).toBe("pending");
	const after = new Database(path);
	expect((after.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(LATEST_MIGRATION);
	after.close();
	s.close();
});

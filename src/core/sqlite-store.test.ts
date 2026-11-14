import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { useCoreSqliteStoreFixtures } from "../testing/core-sqlite-store-fixtures.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { openStore } from "./sqlite-store.ts";

const { open, dirs, file, raw } = useCoreSqliteStoreFixtures();

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
		expect(() =>
			s.claims.claim("queue", { owner: "page", item: "Q-none", deliveryId: "d", message: "m", t: "t" }),
		).toThrow(/no item/);
	});

	test("migrations are recorded, and reopening applies nothing twice", () => {
		const { s, path } = file();
		s.close();
		const again = openStore(path);
		open.push(again);
		const db = raw(path);
		expect(db.query("SELECT version, name FROM migrations ORDER BY version").all()).toEqual(
			MIGRATIONS.map((m) => ({ version: m.version, name: m.name })),
		);
		db.close();
	});

	test("a v0.1.1 database (migrations 1 to 7) upgrades in place: its wakes keep going to the Steward", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v0.1.1.db`;
		const db = raw(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
			db.exec(m.sql);
			db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
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
		const OLD =
			"Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";
		const legacy = [{ hash: "", legacy: "unstamped" as const }];
		for (const version of [7, 8, 9]) {
			const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
			dirs.push(d);
			const path = `${d}/v${version}.db`;
			const db = raw(path);
			db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
			for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
				db.exec(m.sql);
				db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
			}
			const rows: [string, string, string][] = [
				["p1", `a\n${OLD}\nb`, "pending"],
				["plain", "Decision rights (standing rules):\nmerge green PRs", "pending"],
				["dl", "x", "dead_letter"],
				["done", `x\n${OLD}`, "delivered"],
				["gone", `x\n${OLD}`, "cancelled"],
			];
			rows.forEach(([id, message, status], i) => {
				db.query("INSERT INTO outbox (id, delivery_id, message, created_at, status) VALUES (?, ?, ?, 1, ?)").run(
					i + 1,
					id,
					message,
					status,
				);
				db.query("INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES (?, ?, 1)").run(id, i + 1);
			});
			db.exec("INSERT INTO held_wakes (delivery_id, message, queued_at, kind) VALUES ('h-plain', 'held', 2, 'turn')");
			// From schema 8, a wake can be for another receiver (the desk): never the Steward's, so never marked.
			if (version >= 8) {
				db.query(
					"INSERT INTO outbox (id, delivery_id, message, created_at, status, receiver) VALUES (9, 'desk-row', ?, 1, 'pending', 'desk')",
				).run(`x\n${OLD}`);
				db.query("INSERT INTO outbox_members (delivery_id, outbox_id, queued_at) VALUES ('desk-row', 9, 1)").run();
				db.exec(
					"INSERT INTO held_wakes (delivery_id, message, queued_at, kind, receiver) VALUES ('h-desk', 'held', 2, 'turn', 'desk')",
				);
			}
			db.close();
			const s = openStore(path);
			open.push(s);
			const stamps = (id: string) => s.wakes.find(id)?.rights;
			expect([stamps("p1"), stamps("plain"), stamps("dl")]).toEqual([legacy, legacy, legacy]);
			expect([stamps("done"), stamps("gone"), stamps("desk-row")]).toEqual([undefined, undefined, undefined]);
			expect(Object.fromEntries(s.wakes.held().map((h) => [h.deliveryId, h.rights]))).toEqual({
				"h-plain": legacy,
				...(version >= 8 ? { "h-desk": undefined } : {}),
			});
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
		for (const m of MIGRATIONS.filter((x) => x.version <= 9)) {
			db.exec(m.sql);
			db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		const stamp = [{ steward: "s1", session: "x", hash: "h", at: "2026-11-13T18:00:00.000Z" }];
		db.query("INSERT INTO outbox (id, delivery_id, message, created_at, rights_for) VALUES (1, 'w', ?, 1, ?)").run(
			"Decision rights and rulings unchanged since 2026-11-13T18:00:00.000Z and still in force; your hand-off (steward-brief.md) has them.",
			JSON.stringify(stamp),
		);
		db.close();
		const s = openStore(path);
		open.push(s);
		expect(s.wakes.find("w")?.rights).toEqual(stamp);
	});

	test("a database at migration 10 gains the ruling fields: every ruling kept as it was, the new columns empty, the new retirement reasons allowed", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v10.db`;
		const db = raw(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 10)) {
			db.exec(m.sql);
			db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		const ins = db.query(
			"INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, confirmed_at, retired_at, retired_how, item, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(
			"R1",
			1,
			"2026-11-01",
			"w1",
			"d1",
			"chat",
			"in-force",
			1,
			"2026-11-01T09:00:00.000Z",
			null,
			null,
			null,
			'[{"t":"x","what":"stated"}]',
		);
		ins.run("R2", 2, "2026-11-02", "w2", "d2", "card", "proposed", 0, null, null, null, "Q-abc12", "[]");
		ins.run(
			"R10",
			10,
			"2026-11-03",
			"w3",
			"d3",
			"card",
			"retired",
			1,
			"2026-11-03T09:00:00.000Z",
			"2026-11-04T09:00:00.000Z",
			"only this once",
			null,
			"[]",
		);
		const before = db.query("SELECT * FROM rulings ORDER BY seq").all() as Record<string, unknown>[];
		db.close();
		const s = openStore(path);
		open.push(s);
		const after = raw(path);
		expect((after.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(LATEST_MIGRATION);
		expect(LATEST_MIGRATION).toBeGreaterThanOrEqual(11);
		expect(after.query("SELECT version FROM migrations WHERE version = 11").get()).toEqual({ version: 11 });
		// Every old column is as it was; the new ones are NULL.
		const rows = after.query("SELECT * FROM rulings ORDER BY seq").all() as Record<string, unknown>[];
		expect(rows.map((r) => Object.fromEntries(Object.keys(before[0]!).map((k) => [k, r[k]])))).toEqual(before);
		for (const r of rows)
			for (const k of ["retired_why", "superseded_by", "supersedes", "expires", "until_event"]) expect(r[k]).toBeNull();
		after.close();
		expect(s.rulings.list().map((r) => [r.id, r.status, r.confirmed, r.retiredHow, r.item])).toEqual([
			["R1", "in-force", true, undefined, undefined],
			["R2", "proposed", false, undefined, "Q-abc12"],
			["R10", "retired", true, "only this once", undefined],
		]);
		// The new reasons and fields are accepted now, and an unknown reason still is not.
		s.rulings.save({
			...s.rulings.list()[0]!,
			status: "retired",
			retiredHow: "duplicate",
			retiredWhy: "twice",
			supersededBy: "R2",
			expires: "2026-12-01",
			supersedes: ["R10"],
		});
		expect(s.rulings.list()[0]).toMatchObject({
			retiredHow: "duplicate",
			retiredWhy: "twice",
			supersededBy: "R2",
			expires: "2026-12-01",
			supersedes: ["R10"],
		});
		expect(() => s.rulings.save({ ...s.rulings.list()[0]!, retiredHow: "bogus" as never })).toThrow();
		// Ids and order are unchanged: the next id continues after the highest.
		s.rulings.save({
			id: "R11",
			date: "d",
			words: "w",
			decides: "d",
			source: "chat",
			status: "in-force",
			confirmed: true,
			history: [],
		});
		expect(s.rulings.list().map((r) => r.id)).toEqual(["R1", "R2", "R10", "R11"]);
	});
});

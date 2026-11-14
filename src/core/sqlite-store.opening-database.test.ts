/** sqlite-store, continued: see sqlite-store.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { useCoreSqliteStoreFixtures } from "../testing/core-sqlite-store-fixtures.ts";
import { LATEST_MIGRATION, MIGRATIONS } from "./migrations.ts";
import { DatabaseTooNewError, openStore } from "./sqlite-store.ts";

const { open, dirs, mem, file, raw } = useCoreSqliteStoreFixtures();

describe("opening the database", () => {
	test("migration 11 keeps what others added to the rulings table: an index, a trigger, and a child table's ON DELETE CASCADE rows", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v10c.db`;
		const db = raw(path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 10)) {
			db.exec(m.sql);
			db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		db.exec(
			"INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, history) VALUES ('R1', 1, 'd', 'w1', 'd1', 'chat', 'in-force', 1, '[]'), ('R2', 2, 'd', 'w2', 'd2', 'card', 'proposed', 0, '[]')",
		);
		db.exec("CREATE INDEX rulings_by_words ON rulings (words)");
		db.exec("CREATE TABLE ruling_audit (n INTEGER PRIMARY KEY, id TEXT, what TEXT)");
		db.exec(
			"CREATE TRIGGER rulings_audit AFTER UPDATE OF status ON rulings BEGIN INSERT INTO ruling_audit (id, what) VALUES (NEW.id, NEW.status); END",
		);
		db.exec(
			"CREATE TABLE ruling_notes (n INTEGER PRIMARY KEY, ruling TEXT NOT NULL REFERENCES rulings (id) ON DELETE CASCADE, note TEXT)",
		);
		db.exec("INSERT INTO ruling_notes (ruling, note) VALUES ('R1', 'first'), ('R1', 'second'), ('R2', 'third')");
		db.close();
		const s = openStore(path);
		open.push(s);
		const after = raw(path);
		expect((after.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(LATEST_MIGRATION);
		expect(
			after
				.query("SELECT name FROM sqlite_master WHERE name IN ('rulings_by_words', 'rulings_audit') ORDER BY name")
				.all(),
		).toEqual([{ name: "rulings_audit" }, { name: "rulings_by_words" }]);
		expect(after.query("SELECT ruling, note FROM ruling_notes ORDER BY n").all()).toEqual([
			{ ruling: "R1", note: "first" },
			{ ruling: "R1", note: "second" },
			{ ruling: "R2", note: "third" },
		]);
		// The child's foreign key still points at rulings, and the added trigger still fires.
		expect(after.query("SELECT \"table\" AS t FROM pragma_foreign_key_list('ruling_notes')").all()).toEqual([
			{ t: "rulings" },
		]);
		after.close();
		s.rulings.save({
			...s.rulings.list()[0]!,
			status: "retired",
			retiredHow: "superseded",
			retiredWhy: "replaced by R2",
			supersededBy: "R2",
		});
		const again = raw(path);
		expect(again.query("SELECT id, what FROM ruling_audit").all()).toEqual([{ id: "R1", what: "retired" }]);
		expect(again.query("SELECT COUNT(*) AS n FROM ruling_notes").get()).toEqual({ n: 3 });
		expect(again.query("PRAGMA foreign_key_check").all()).toEqual([]);
		again.close();
	});

	for (const version of [7, 8, 9, 10]) {
		test(`a database at migration ${version} upgrades: its rulings kept, every retirement reason storable, an unknown one refused`, () => {
			const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
			dirs.push(d);
			const path = `${d}/v${version}r.db`;
			const db = raw(path);
			db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
			for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
				db.exec(m.sql);
				db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
			}
			db.exec(
				"INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, retired_at, retired_how, history) VALUES ('R1', 1, 'd', 'w1', 'd1', 'chat', 'in-force', 1, NULL, NULL, '[]'), ('R2', 2, 'd', 'w2', 'd2', 'card', 'retired', 1, 't', 'only this once', '[]')",
			);
			db.close();
			const s = openStore(path);
			open.push(s);
			expect(s.rulings.list().map((r) => [r.id, r.status, r.retiredHow])).toEqual([
				["R1", "in-force", undefined],
				["R2", "retired", "only this once"],
			]);
			const base = s.rulings.list()[0]!;
			for (const how of ["retired", "only this once", "superseded", "duplicate", "expired", "repeat"] as const) {
				s.rulings.save({ ...base, status: "retired", retiredHow: how, retiredWhy: "why" });
				expect(s.rulings.list()[0]!.retiredHow).toBe(how);
			}
			expect(() => s.rulings.save({ ...base, status: "retired", retiredHow: "bogus" as never })).toThrow();
		});
	}

	test("the database itself holds retired_reason to its four values, and only on a row retired_how 'retired'", () => {
		const { s, path } = file();
		s.rulings.save({
			id: "R1",
			date: "d",
			words: "w",
			decides: "d",
			source: "chat",
			status: "in-force",
			confirmed: true,
			history: [],
		});
		s.close();
		const db = raw(path);
		expect(() =>
			db.exec("UPDATE rulings SET retired_how = 'retired', retired_reason = 'bogus' WHERE id = 'R1'"),
		).toThrow(/retired_reason/);
		expect(() =>
			db.exec("UPDATE rulings SET retired_how = 'only this once', retired_reason = 'duplicate' WHERE id = 'R1'"),
		).toThrow(/retired_reason/);
		expect(() =>
			db.exec(
				"INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, retired_how, retired_reason) VALUES ('R2', 2, 'd', 'w', 'd', 'chat', 'retired', 1, NULL, 'expired')",
			),
		).toThrow(/retired_reason/);
		db.exec(
			"UPDATE rulings SET status = 'retired', retired_how = 'retired', retired_reason = 'repeat' WHERE id = 'R1'",
		);
		expect(db.query("SELECT retired_how, retired_reason FROM rulings").get()).toEqual({
			retired_how: "retired",
			retired_reason: "repeat",
		});
		db.close();
	});

	test("migration 11 is one transaction: a failure leaves the database at 10, rulings untouched", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/v10b.db`;
		const db = raw(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= 10)) {
			db.exec(m.sql);
			db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		db.exec(
			"INSERT INTO rulings (id, seq, date, words, decides, source, status, confirmed, history) VALUES ('R1', 1, 'd', 'w', 'd', 'chat', 'in-force', 1, '[]')",
		);
		// A leftover trigger of the same name makes the migration fail part-way, after its columns are added.
		db.exec("CREATE TRIGGER rulings_retired_reason_update AFTER UPDATE ON rulings BEGIN SELECT 1; END");
		db.close();
		expect(() => openStore(path)).toThrow();
		const after = raw(path);
		expect((after.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(10);
		expect(after.query("SELECT id FROM rulings").all()).toEqual([{ id: "R1" }]);
		expect(after.query("SELECT name FROM pragma_table_info('rulings') WHERE name = 'expires'").all()).toEqual([]);
		after.close();
	});

	test("a database newer than this build is refused with a clear error", () => {
		const { s, path } = file();
		s.close();
		const db = raw(path);
		db.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, 'from the future', 'now')").run(
			LATEST_MIGRATION + 1,
		);
		db.close();
		expect(() => openStore(path)).toThrow(DatabaseTooNewError);
		expect(() => openStore(path)).toThrow(
			new RegExp(`migration ${LATEST_MIGRATION + 1}.*understands up to ${LATEST_MIGRATION}.*newer Chamberlain`),
		);
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
		expect(() =>
			s.tx(() => {
				s.state.set("a", 1);
				throw Error("boom");
			}),
		).toThrow("boom");
		expect(s.state.get("a")).toBeUndefined();
		s.tx(() => {
			s.state.set("outer", 1);
			expect(() =>
				s.tx(() => {
					s.state.set("inner", 1);
					throw Error("no");
				}),
			).toThrow("no");
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

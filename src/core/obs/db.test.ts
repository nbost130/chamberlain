/** The telemetry database's own migrations, tried on throwaway databases only. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { MIGRATIONS } from "../migrations.ts";
import { OBS_MIGRATIONS, ObsTooNewError, openObsDb } from "./db.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-obsdb-`);
	dirs.push(d);
	return d;
};

describe("obs.db's schema", () => {
	test("the events table has the design's columns and nothing the design does not name", () => {
		const db = openObsDb(":memory:");
		const cols = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
		expect(cols).toEqual([
			"id",
			"t",
			"level",
			"host",
			"run",
			"mod",
			"event",
			"corr",
			"delivery",
			"thread",
			"source_key",
			"data",
		]);
		db.close();
	});

	test("source_key is unique, level and data are checked", () => {
		const db = openObsDb(":memory:");
		const put = (level: string, key: string | null, data: string) =>
			db
				.query(
					"INSERT INTO events (t, level, host, run, mod, event, source_key, data) VALUES ('t', ?, 'h', 'r', 'm', 'e', ?, ?)",
				)
				.run(level, key, data);
		put("info", "decision:1", "{}");
		expect(() => put("info", "decision:1", "{}")).toThrow();
		put("info", null, "{}");
		put("info", null, "{}");
		expect(() => put("loud", "decision:2", "{}")).toThrow();
		expect(() => put("info", "decision:3", "not json")).toThrow();
		db.close();
	});

	test("opening it again applies nothing twice, and the file is private WAL", () => {
		const path = `${scratch()}/obs.db`;
		openObsDb(path).close();
		const db = openObsDb(path);
		expect((db.query("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n).toBe(OBS_MIGRATIONS.length);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		db.close();
	});

	test("a database a newer build wrote is refused, naming the reason, and is not changed", () => {
		const path = `${scratch()}/obs.db`;
		const raw = new Database(path);
		raw.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		raw.query("INSERT INTO migrations VALUES (99, 'future', 'now')").run();
		raw.close();
		expect(() => openObsDb(path)).toThrow(ObsTooNewError);
		const after = new Database(path, { readonly: true });
		expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "migrations" }]);
		after.close();
	});

	test("its migrations are its own: the ledger's list names no telemetry table", () => {
		const sql = MIGRATIONS.map((m) => m.sql).join("\n");
		expect(sql).not.toMatch(/obs_counter|source_key/);
		expect(new Set(OBS_MIGRATIONS.map((m) => m.version)).size).toBe(OBS_MIGRATIONS.length);
	});
});

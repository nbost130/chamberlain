import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InsecureModeError } from "../../core/private.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { dbPath } from "../../core/store.ts";
import { MAIL_DB_FILE, MailDatabaseTooNewError, type MailDb, mailDbPath, openMailDb } from "./db.ts";
import { LATEST_MAIL_MIGRATION, MAIL_MIGRATIONS } from "./migrations.ts";

const open: MailDb[] = [];
afterEach(() => {
	for (const d of open.splice(0)) d.close();
});
const state = () => join(mkdtempSync(join(tmpdir(), "mail-db-")), "state");
const mailDb = (dir: string) => {
	const d = openMailDb(dir);
	open.push(d);
	return d;
};

describe("mail.db", () => {
	test("it is <state>/mail.db, made private, in WAL mode, with its own migrations applied", () => {
		const dir = state();
		expect(mailDbPath(dir)).toBe(join(dir, MAIL_DB_FILE));
		expect(existsSync(mailDbPath(dir))).toBe(false);
		const db = mailDb(dir);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(db.path).mode & 0o777).toBe(0o600);
		expect(db.one("PRAGMA journal_mode")?.journal_mode).toBe("wal");
		expect(db.one("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
		expect(db.all("SELECT version, name FROM migrations")).toEqual([{ version: 1, name: "initial schema" }]);
		expect(LATEST_MAIL_MIGRATION).toBe(MAIL_MIGRATIONS.length);
		// The -wal and -shm files SQLite makes copy the main file's mode.
		for (const suffix of ["-wal", "-shm"])
			if (existsSync(db.path + suffix)) expect(statSync(db.path + suffix).mode & 0o777).toBe(0o600);
	});

	test("opening it again applies nothing twice", () => {
		const dir = state();
		mailDb(dir).run("INSERT INTO mail_state (key, value, updated_at) VALUES ('cursor', 'h1', 1)");
		const again = mailDb(dir);
		expect(again.all("SELECT version FROM migrations")).toEqual([{ version: 1 }]);
		expect(again.all("SELECT key, value FROM mail_state")).toEqual([{ key: "cursor", value: "h1" }]);
	});

	test("it is its own file with its own migrations: nothing of it is in chamberlain.db, and nothing of chamberlain.db is in it", () => {
		const dir = state();
		const main = openStore(dbPath(dir));
		const mine = mailDb(dir);
		try {
			const tables = (c: Database) =>
				(c.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
			const raw = new Database(dbPath(dir), { readonly: true });
			expect(tables(raw).filter((t) => t.startsWith("mail_"))).toEqual([]);
			raw.close();
			expect(mine.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'")).toEqual([]);
			expect(
				mine.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_%' ORDER BY name"),
			).toEqual([{ name: "mail_messages" }, { name: "mail_state" }]);
		} finally {
			main.close();
		}
	});

	test("a database from a newer build is refused, with the reason, and left as it was", () => {
		const dir = state();
		mailDb(dir).close();
		open.pop();
		const raw = new Database(mailDbPath(dir));
		raw
			.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, 'from the future', 'now')")
			.run(LATEST_MAIL_MIGRATION + 1);
		raw.close();
		let err: unknown;
		try {
			openMailDb(dir);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(MailDatabaseTooNewError);
		expect((err as Error).message).toContain(`migration ${LATEST_MAIL_MIGRATION + 1}`);
		expect((err as Error).message).toContain(`understands up to ${LATEST_MAIL_MIGRATION}`);
		expect((err as Error).message).toContain("Refusing to read or write it");
		const after = new Database(mailDbPath(dir), { readonly: true });
		expect(after.query("SELECT MAX(version) AS v FROM migrations").get()).toEqual({ v: LATEST_MAIL_MIGRATION + 1 });
		after.close();
	});

	test("a state directory or file that cannot be made private is a refusal, never a database anyone can read", () => {
		const dir = state();
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		expect(() => openMailDb(dir, { chmod: () => {} })).toThrow(InsecureModeError);
		expect(existsSync(mailDbPath(dir))).toBe(false);
	});
});

describe("mail.db keeps metadata and bounded derived text, never a mail body", () => {
	const names = (db: MailDb) =>
		db
			.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations') ORDER BY name")
			.map((r) => r.name as string);

	test("no column is named for a body", () => {
		const db = mailDb(state());
		const columns = names(db).flatMap((t) => db.all(`PRAGMA table_info(${t})`).map((c) => `${t}.${c.name}`));
		expect(columns.length).toBeGreaterThan(10);
		for (const c of columns)
			expect(c, c).not.toMatch(/body|html|content|snippet|raw|payload|plain|full_text|message_text/i);
	});

	test("every text column that is not a key or an id is capped by a length CHECK, and so are the ids", () => {
		const db = mailDb(state());
		for (const table of names(db)) {
			const sql = db.one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql as string;
			for (const col of db.all(`PRAGMA table_info(${table})`).filter((c) => c.type === "TEXT")) {
				const name = col.name as string;
				expect(sql, `${table}.${name}`).toMatch(new RegExp(`length\\(${name}\\) <= \\d+`));
			}
		}
	});

	test("the caps bite: a subject over 120 characters, an id over 200 and a value over 1000 are refused", () => {
		const db = mailDb(state());
		const insert = (subject: string, id = "m1") =>
			db.run(
				"INSERT INTO mail_messages (provider_id, subject, outcome, triaged_at) VALUES (?, ?, 'keep', 1)",
				id,
				subject,
			);
		expect(() => insert("s".repeat(120))).not.toThrow();
		expect(() => insert("s".repeat(121), "m2")).toThrow(/CHECK constraint/);
		expect(() => insert("ok", "i".repeat(201))).toThrow(/CHECK constraint/);
		expect(() => insert("again", "m1")).toThrow(/UNIQUE constraint/);
		expect(() =>
			db.run("INSERT INTO mail_state (key, value, updated_at) VALUES ('k', ?, 1)", "v".repeat(1001)),
		).toThrow(/CHECK constraint/);
		expect(() =>
			db.run("INSERT INTO mail_state (key, value, updated_at) VALUES ('k', ?, 1)", "v".repeat(1000)),
		).not.toThrow();
	});

	test("a subject can be cleared to NULL after 30 days, and tokens cannot go negative", () => {
		const db = mailDb(state());
		db.run("INSERT INTO mail_messages (provider_id, subject, outcome, triaged_at) VALUES ('a', 'hello', 'keep', 1)");
		expect(() => db.run("UPDATE mail_messages SET subject = NULL WHERE provider_id = 'a'")).not.toThrow();
		expect(() => db.run("UPDATE mail_messages SET input_tokens = -1 WHERE provider_id = 'a'")).toThrow(
			/CHECK constraint/,
		);
	});
});

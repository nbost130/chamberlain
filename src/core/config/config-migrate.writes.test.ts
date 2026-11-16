/** config-migrate, continued: see config-migrate.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { useCoreConfigMigrateFixtures } from "../../testing/core-config-migrate-fixtures.ts";
import { FAKE, writeLegacyConf } from "../../testing/legacy-conf.ts";
import { holdFlock } from "../flock.ts";
import { envValue, parseEnvFile } from "./config-fold.ts";
import { migrateLayout, setThread, startupLayout } from "./config-migrate.ts";
import { planMigration } from "./config-plan.ts";
import { revertLayout } from "./config-revert.ts";
import { thread } from "./layout.ts";

const { fresh, json } = useCoreConfigMigrateFixtures();

describe("writes", () => {
	test("setThread on an old-layout directory migrates it first, so nothing the old files held is lost", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		setThread(conf, "steward", "fake-new-steward");
		const c = json(`${conf}/config.json`);
		expect(c.threads.steward).toBe("fake-new-steward");
		expect(c.threads.decisions).toBe(FAKE.decisionsThread);
		expect(c.principal).toBe("Ada");
		expect(thread(conf, "steward")).toBe("fake-new-steward");
		// no stale steward-thread is left for a tool outside Chamberlain to read as the Steward
		expect(existsSync(`${conf}/steward-thread`)).toBe(false);
		expect(readFileSync(`${conf}/steward-thread.migrated`, "utf8").trim()).toBe(FAKE.stewardThread);
	});
	test("startupLayout migrates once and logs it; a start after it logs nothing about the layout", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const lines: [string, Record<string, unknown>?][] = [];
		startupLayout(conf, (e, d) => lines.push([e, d]));
		expect(lines.map(([e]) => e)).toEqual(["config-migrated"]);
		expect(JSON.stringify(lines)).not.toContain(FAKE.wakeUrl);
		const d = lines[0]![1]!;
		expect(d.secrets as string[]).toContain("wake-url");
		expect(d.renamed as string[]).toContain("steward-thread.migrated");
		expect(existsSync(`${conf}/wake-url`)).toBe(false);
		const second: [string, Record<string, unknown>?][] = [];
		startupLayout(conf, (e, d) => second.push([e, d]));
		expect(second).toEqual([]);
	});
	test("a read-only config directory is logged, not fatal", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		chmodSync(conf, 0o500);
		const lines: string[] = [];
		try {
			startupLayout(conf, (e) => lines.push(e));
		} finally {
			chmodSync(conf, 0o700);
		}
		if (process.getuid?.() !== 0) expect(lines).toContain("config-migrate-failed");
	});
});

describe("daemon.env", () => {
	test("parseEnvFile reads KEY=value lines, strips quotes and skips comments", () => {
		expect(parseEnvFile("# c\nA=1\nexport B=\"two\"\n  C='three'\nnot a line\nD=\n")).toEqual([
			["A", "1"],
			["B", "two"],
			["C", "three"],
			["D", ""],
		]);
	});
	test("envValue types a value by its key and refuses an unusable one", () => {
		expect(envValue("stallMs", "1000")).toBe(1000);
		expect(envValue("stallMs", "-1")).toBeUndefined();
		expect(envValue("maxAttempts", "2.5")).toBeUndefined();
		expect(envValue("recover", "1")).toBe(true);
		expect(envValue("recover", "0")).toBe(false);
		expect(envValue("exclude", "a, b")).toEqual(["a", "b"]);
		expect(envValue("principal", "")).toBeUndefined();
	});
	test("a daemon.env that is not 0600 is not read", () => {
		const conf = fresh();
		writeFileSync(`${conf}/daemon.env`, "CHAMBERLAIN_RECOVER=1\n", { mode: 0o644 });
		chmodSync(`${conf}/daemon.env`, 0o644);
		const p = planMigration(conf);
		expect(p.added).toEqual([]);
		expect(p.problems.join("\n")).toContain("daemon.env");
	});
});

describe("plan edge cases pinned before the lint refactor", () => {
	const writeConfig = (conf: string, doc: object) =>
		writeFileSync(`${conf}/config.json`, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
	const priv = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });

	test("a key config.json holds with another value than the old file is reported, and config.json wins", () => {
		const conf = fresh();
		priv(
			`${conf}/settings.json`,
			`${JSON.stringify({ schemaVersion: 2, principalName: "Old File", compactTokens: 5 })}\n`,
		);
		writeConfig(conf, { principal: "From Config", compactTokens: 5 });
		const p = planMigration(conf);
		expect(p.differs).toEqual([{ key: "principal", from: "settings.json" }]);
		expect(p.added).toEqual([]);
		expect(p.config.principal).toBe("From Config");
		expect(p.writeConfig).toBe(false);
	});

	test("a thread id config.json holds is reported when the old file differs; a thread file others can read is a problem", () => {
		const conf = fresh();
		writeConfig(conf, { threads: { steward: "from-config" } });
		priv(`${conf}/steward-thread`, "from-file\n");
		writeFileSync(`${conf}/decisions-thread`, "readable\n", { mode: 0o644 });
		chmodSync(`${conf}/decisions-thread`, 0o644);
		const p = planMigration(conf);
		expect(p.differs).toEqual([{ key: "threads.steward", from: "steward-thread" }]);
		expect(p.problems).toEqual(["decisions-thread must be a private regular file with mode exactly 0600 (it is 0644)"]);
		expect((p.config.threads as Record<string, string>).steward).toBe("from-config");
	});

	test("a settings.json that is not JSON is reported as a problem and does not stop the plan", () => {
		const conf = fresh();
		priv(`${conf}/settings.json`, "{not json");
		priv(`${conf}/steward-thread`, "t-1\n");
		const p = planMigration(conf);
		// One report per key the file would have supplied, each the parser's own message.
		expect(p.problems).toHaveLength(6);
		expect(p.problems.every((x) => x.startsWith("JSON Parse error"))).toBe(true);
		expect(p.added).toEqual([{ key: "threads.steward", from: "steward-thread" }]);
	});

	test("secrets the config names: a missing one is a note, a directory is skipped, a moved one that is gone is not moved back", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		rmSync(`${conf}/secrets/laptop-token`);
		priv(`${conf}/laptop-token`, "written-again\n");
		mkdirSync(`${conf}/dir-token`);
		writeConfig(conf, {
			...json(`${conf}/config.json`),
			servers: [
				{ name: "a", adapter: "t3", origin: "http://127.0.0.1:1", tokenFile: "ghost-token" },
				{ name: "b", adapter: "t3", origin: "http://127.0.0.1:2", tokenFile: "dir-token" },
			],
		});
		const p = planMigration(conf);
		expect(p.notes).toContain(
			"ghost-token: named by the config, but there is no such file in secrets/ or the config directory",
		);
		expect(p.secrets.find((s) => s.name === "dir-token")).toEqual({
			name: "dir-token",
			action: "skip",
			why: "not a regular file",
		});
		expect(p.secrets.find((s) => s.name === "laptop-token")).toEqual({
			name: "laptop-token",
			action: "skip",
			why: "moved by an earlier migration and now gone from secrets/: not moved back",
		});
	});

	test("a migration that cannot take the config directory's lock reports it and writes nothing, for migrate and for revert", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const held = holdFlock(conf, { waitMs: 0 });
		try {
			const m = migrateLayout(conf, { waitMs: 0 });
			expect(m.changed).toBe(false);
			expect(m.skipped).toContain("could not lock the config directory");
			expect(existsSync(`${conf}/config.json`)).toBe(false);
			const r = revertLayout(conf, { waitMs: 0 });
			expect(r.skipped).toContain("could not lock the config directory");
			expect(r.done).toEqual([]);
		} finally {
			held.release();
		}
	});

	test("a revert with an unreadable config.json.reverted says which secrets it cannot move back", () => {
		const conf = fresh();
		priv(`${conf}/config.json.reverted`, "{not json");
		const r = revertLayout(conf, { dryRun: true });
		expect(r.problems).toEqual([
			"config.json.reverted is not readable: the secrets it lists cannot be moved back from it",
		]);
		expect(r.done).toEqual(["nothing to revert"]);
	});
});

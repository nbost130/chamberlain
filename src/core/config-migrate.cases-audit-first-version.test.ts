/** config-migrate, continued: see config-migrate.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { useCoreConfigMigrateFixtures } from "../testing/core-config-migrate-fixtures.ts";
import { FAKE, SETTINGS, writeLegacyConf } from "../testing/legacy-conf.ts";
import { readSettings } from "./config.ts";
import { envValue } from "./config-fold.ts";
import { migrateLayout } from "./config-migrate.ts";
import { planMigration } from "./config-plan.ts";
import { readNamed, readSecret, setting, thread } from "./layout.ts";
import { attachDeprecationLog } from "./layout-legacy.ts";
import { readConfigFile } from "./layout-read.ts";
import { ENV_KEYS } from "./layout-schema.ts";
import { readServers } from "./servers.ts";

const { fresh, mode, json, NONE } = useCoreConfigMigrateFixtures();

describe("the cases an audit of the first version found", () => {
	test("names the live list does not have: judge.json, read-token, hand-off URL files, t3StateDb, an unknown settings key", () => {
		const conf = fresh();
		writeFileSync(
			`${conf}/judge.json`,
			JSON.stringify({ triggers: {}, backends: { b: { command: ["/fake/judge"] } } }),
			{ mode: 0o600 },
		);
		writeFileSync(`${conf}/read-token`, "fake-read\n", { mode: 0o600 });
		writeFileSync(`${conf}/wake-url.steward`, "https://fake.example/steward\n", { mode: 0o600 });
		writeFileSync(`${conf}/wake-url.prev`, "https://fake.example/prev\n", { mode: 0o600 });
		writeFileSync(
			`${conf}/settings.json`,
			JSON.stringify({ schemaVersion: 2, t3StateDb: "/fake/state.sqlite", quietHours: "22-7" }),
			{ mode: 0o600 },
		);
		const r = migrateLayout(conf);
		const c = json(`${conf}/config.json`);
		expect(c.judge).toEqual({ triggers: {}, backends: { b: { command: ["/fake/judge"] } } });
		expect(c.t3StateDb).toBe("/fake/state.sqlite");
		for (const [n, v] of [
			["read-token", "fake-read"],
			["wake-url.steward", "https://fake.example/steward"],
			["wake-url.prev", "https://fake.example/prev"],
		] as const)
			expect(readFileSync(`${conf}/secrets/${n}`, "utf8")).toBe(`${v}\n`);
		expect(r.plan.notes.join("\n")).toContain("quietHours is not read by this build");
	});

	test("a token file called credential.md is a secret, not prose", () => {
		const conf = fresh();
		writeFileSync(
			`${conf}/servers.json`,
			JSON.stringify({
				schemaVersion: 2,
				servers: [{ name: "a", adapter: "t3", origin: "http://x", tokenFile: "credential.md" }],
			}),
			{ mode: 0o600 },
		);
		writeFileSync(`${conf}/credential.md`, "fake-md-token\n", { mode: 0o600 });
		migrateLayout(conf);
		expect(existsSync(`${conf}/credential.md`)).toBe(false);
		expect(readNamed(conf, "credential.md")).toBe("fake-md-token");
		writeFileSync(`${conf}/decision-rights.md`, "# rights\n", { mode: 0o600 });
		expect(readNamed(conf, "decision-rights.md")).toBe("# rights");
		expect(existsSync(`${conf}/secrets/decision-rights.md`)).toBe(false);
	});

	test("a webhook file that is a symlink to a regular 0600 file is written by content, and the link is set aside", () => {
		const conf = fresh();
		writeFileSync(`${conf}/real-hook`, "https://fake.example/linked\n", { mode: 0o600 });
		symlinkSync(`${conf}/real-hook`, `${conf}/wake-url`);
		migrateLayout(conf);
		expect(readFileSync(`${conf}/secrets/wake-url`, "utf8")).toBe("https://fake.example/linked\n");
		expect(lstatSync(`${conf}/secrets/wake-url`).isSymbolicLink()).toBe(false);
		expect(mode(`${conf}/secrets/wake-url`)).toBe(0o600);
		expect(existsSync(`${conf}/wake-url`)).toBe(false);
		expect(lstatSync(`${conf}/wake-url.migrated`).isSymbolicLink()).toBe(true);
		expect(readFileSync(`${conf}/real-hook`, "utf8")).toBe("https://fake.example/linked\n"); // the target is untouched
	});

	test('"threads": null in config.json means none: it is not refilled from the old files, and no fallback reads them', () => {
		const conf = fresh();
		writeLegacyConf(conf);
		writeFileSync(`${conf}/config.json`, JSON.stringify({ schemaVersion: 1, threads: null }), { mode: 0o600 });
		const r = migrateLayout(conf);
		expect(r.plan.added.map((a) => a.key).filter((k) => k.startsWith("threads"))).toEqual([]);
		expect(json(`${conf}/config.json`).threads).toBeNull();
		expect(thread(conf, "steward")).toBeUndefined();
	});

	test("a secret keeps its date through the move (the token-age alarm reads it), and no temporary file is left", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const old = new Date(Date.now() - 40 * 86_400_000);
		utimesSync(`${conf}/laptop-token`, old, old);
		migrateLayout(conf);
		expect(Math.abs(statSync(`${conf}/secrets/laptop-token`).mtimeMs - old.getTime())).toBeLessThan(2);
		expect(readdirSync(`${conf}/secrets`).filter((n) => n.includes(".tmp-"))).toEqual([]);
	});

	test("CHAMBERLAIN_RECOVER=true does not turn recovery on: only 1 does, as before", () => {
		const conf = fresh();
		expect(setting("recover", conf, { CHAMBERLAIN_RECOVER: "true" })).toBeUndefined();
		expect(setting("recover", conf, { CHAMBERLAIN_RECOVER: "yes" })).toBeUndefined();
		expect(setting("recover", conf, { CHAMBERLAIN_RECOVER: "1" })).toBe(true);
		writeFileSync(`${conf}/daemon.env`, "CHAMBERLAIN_RECOVER=true\n", { mode: 0o600 });
		expect(planMigration(conf).added).toEqual([]);
		expect(envValue("recover", "true")).toBeUndefined();
	});

	test("a daemon.env value that disagrees with settings.json is reported, and the file's value is the one kept", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const r = migrateLayout(conf);
		expect(r.plan.differs.find((d) => d.key === "alertCmd")?.from).toContain("daemon.env");
		expect(json(`${conf}/config.json`).alertCmd).toBe(SETTINGS.alertCommand);
	});
});

describe("the old layout is still read until it is removed", () => {
	test("each old file serves its key when config.json is absent, and says so once in the events log", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const seen: [string, Record<string, unknown>][] = [];
		attachDeprecationLog((e, d) => seen.push([e, d]));
		expect(readServers(conf)).toHaveLength(3);
		expect(readServers(conf)).toHaveLength(3);
		expect(thread(conf, "steward")).toBe(FAKE.stewardThread);
		expect(readSecret(conf, "wake-url")).toBe(FAKE.wakeUrl);
		expect(setting("principal", conf, NONE)).toBe("Ada");
		const files = seen.map(([, d]) => d.file);
		expect(files.sort()).toEqual(["servers.json", "settings.json", "steward-thread", "wake-url"]);
		expect(seen.every(([e]) => e === "config-deprecated")).toBe(true);
		expect(JSON.stringify(seen)).not.toContain(FAKE.wakeUrl);
	});

	test("config.json wins, a key it holds as null means none, and a key it lacks falls back", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		writeFileSync(`${conf}/config.json`, JSON.stringify({ schemaVersion: 1, principal: "New", alertCmd: null }), {
			mode: 0o600,
		});
		expect(setting("principal", conf, NONE)).toBe("New");
		expect(setting("alertCmd", conf, NONE)).toBeUndefined();
		expect(setting("compactTokens", conf, NONE)).toBe(SETTINGS.compactTokens);
	});

	test("a secret in secrets/ is read before the old place", () => {
		const conf = fresh();
		mkdirSync(`${conf}/secrets`, { mode: 0o700 });
		writeFileSync(`${conf}/wake-url`, "old\n", { mode: 0o600 });
		writeFileSync(`${conf}/secrets/wake-url`, "new\n", { mode: 0o600 });
		expect(readSecret(conf, "wake-url")).toBe("new");
	});

	test("a secret that is not 0600 is refused in both places", () => {
		const conf = fresh();
		mkdirSync(`${conf}/secrets`, { mode: 0o700 });
		writeFileSync(`${conf}/secrets/wake-url`, "x\n", { mode: 0o644 });
		chmodSync(`${conf}/secrets/wake-url`, 0o644);
		expect(() => readSecret(conf, "wake-url")).toThrow("0600");
		writeFileSync(`${conf}/tok-token`, "x\n", { mode: 0o644 });
		chmodSync(`${conf}/tok-token`, 0o644);
		expect(() => readSecret(conf, "tok-token")).toThrow("0600");
	});

	test("a secret name cannot climb out of secrets/", () => {
		const conf = fresh();
		writeFileSync(`${conf}/../outside-token`, "x\n", { mode: 0o600 });
		expect(readSecret(conf, "../outside-token")).toBeUndefined();
		expect(readSecret(conf, "/etc/hostname")).toBeUndefined();
	});
});

describe("config.json is checked when it is read", () => {
	const write = (conf: string, doc: unknown, m = 0o600) => {
		writeFileSync(`${conf}/config.json`, typeof doc === "string" ? doc : JSON.stringify(doc), { mode: m });
		chmodSync(`${conf}/config.json`, m);
	};
	test("an unknown key, a wrong type and bad JSON are refused with the key named", () => {
		const conf = fresh();
		write(conf, { schemaVersion: 1, princpal: "x" });
		expect(() => readConfigFile(conf)).toThrow('unknown key "princpal"');
		write(conf, { schemaVersion: 1, stallMs: "soon" });
		expect(() => readConfigFile(conf)).toThrow('"stallMs" must be a number');
		write(conf, { schemaVersion: 1, threads: { steward: "a", oops: "b" } });
		expect(() => readConfigFile(conf)).toThrow("threads");
		write(conf, "{ not json");
		expect(() => readConfigFile(conf)).toThrow("not valid JSON");
	});
	test("settledMatch is checked as settings.json checked it: unknown keys and wrong types are refused", () => {
		const conf = fresh();
		write(conf, { schemaVersion: 1, settledMatch: { titleOverlap: "no" } });
		expect(() => readConfigFile(conf)).toThrow("titleOverlap");
		write(conf, { schemaVersion: 1, settledMatch: { ignoreWords: ["a", ""] } });
		expect(() => readConfigFile(conf)).toThrow("ignoreWords");
		write(conf, { schemaVersion: 1, settledMatch: { colour: 1 } });
		expect(() => readConfigFile(conf)).toThrow("unknown keys: colour");
		write(conf, { schemaVersion: 1, settledMatch: { titleOverlap: false, ignoreWords: [" acme "] } });
		expect(readSettings(conf).settledMatch).toEqual({ titleOverlap: false, ignoreWords: ["acme"] }); // trimmed
	});
	test("a newer schemaVersion is refused, never guessed at", () => {
		const conf = fresh();
		write(conf, { schemaVersion: 2 });
		expect(() => readConfigFile(conf)).toThrow("newer Chamberlain");
	});
	test("a file that others can write is refused (it names commands the daemon runs), 0644 is fine", () => {
		const conf = fresh();
		write(conf, { schemaVersion: 1 }, 0o664);
		expect(() => readConfigFile(conf)).toThrow("group-writable");
		write(conf, { schemaVersion: 1 }, 0o644);
		expect(readConfigFile(conf)).toEqual({ schemaVersion: 1 });
	});
});

describe("environment variables override a key by one naming rule", () => {
	test("CHAMBERLAIN_ + the key in UPPER_SNAKE_CASE", () => {
		const conf = fresh();
		writeFileSync(
			`${conf}/config.json`,
			JSON.stringify({
				schemaVersion: 1,
				principal: "File",
				stallMs: 5,
				exclude: ["a"],
				recover: false,
				maxAttempts: 4,
			}),
			{ mode: 0o600 },
		);
		const env = {
			CHAMBERLAIN_PRINCIPAL: "Env",
			CHAMBERLAIN_T3_STATE_DB: "/x/db",
			CHAMBERLAIN_STALL_MS: "99",
			CHAMBERLAIN_EXCLUDE: "t1, t2",
			CHAMBERLAIN_RECOVER: "1",
			CHAMBERLAIN_MAX_ATTEMPTS: "nope",
		};
		expect(setting("principal", conf, env)).toBe("Env");
		expect(setting("t3StateDb", conf, env)).toBe("/x/db");
		expect(setting("stallMs", conf, env)).toBe(99);
		expect(setting("exclude", conf, env)).toEqual(["t1", "t2"]);
		expect(setting("recover", conf, env)).toBe(true);
		expect(setting("recover", conf, { CHAMBERLAIN_RECOVER: "0" })).toBe(false);
		expect(setting("maxAttempts", conf, env)).toBe(4); // an unusable value is ignored, so the file's holds
		expect(setting("principal", conf, NONE)).toBe("File");
	});
	test("every environment variable the first Chamberlain read for a setting is still the one the rule gives", () => {
		for (const name of [
			"CHAMBERLAIN_PRINCIPAL",
			"CHAMBERLAIN_T3_DIR",
			"CHAMBERLAIN_T3_STATE_DB",
			"CHAMBERLAIN_T3_ORIGIN",
			"CHAMBERLAIN_ALERT_CMD",
			"CHAMBERLAIN_COMPACT_TOKENS",
			"CHAMBERLAIN_RECOVER",
			"CHAMBERLAIN_EXCLUDE",
			"CHAMBERLAIN_REPORT_QUIET_MS",
			"CHAMBERLAIN_REPORT_HOLD_MS",
			"CHAMBERLAIN_STALL_MS",
			"CHAMBERLAIN_CARD_UNVERIFIED_ALARM_MS",
			"CHAMBERLAIN_MAX_ATTEMPTS",
			"CHAMBERLAIN_GH",
			"CHAMBERLAIN_HEALTH_FORMAT_PATTERN",
		])
			expect(ENV_KEYS[name]).toBeDefined();
	});
});

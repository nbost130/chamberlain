import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	readdirSync,
	utimesSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	ALERT_DESK,
	DAEMON_ENV,
	DECISION_RIGHTS,
	FAKE,
	OPERATING_RULES,
	SERVERS,
	SETTINGS,
	SWEEP,
	WEB,
	legacyFiles,
	tokensFor,
	writeLegacyConf,
} from "../testing/legacy-conf.ts";

const TOKENS = tokensFor();
import { planLines, showLines } from "./config-cmd.ts";
import { envValue, migrateLayout, parseEnvFile, planMigration, setThread, startupLayout } from "./config-migrate.ts";
import {
	ENV_KEYS,
	attachDeprecationLog,
	cfg,
	readConfigFile,
	readNamed,
	readSecret,
	resetLayout,
	setting,
	thread,
} from "./layout.ts";
import { readServers } from "./servers.ts";
import { readSweepConfig } from "./sweep.ts";
import { readConfig, readOperator } from "./alert-desk.ts";
import { loadConfig } from "../web/config.ts";
import { readSettings } from "./config.ts";

const dirs: string[] = [];
const fresh = () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-confmig-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	mkdirSync(conf, { mode: 0o700 });
	return conf;
};
afterEach(() => {
	resetLayout();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;
const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
const NONE = {} as Record<string, string | undefined>;

describe("the live install's twenty file names, with fake values, migrate to the new layout", () => {
	test("the fixture has exactly the twenty names of the old layout", () => {
		expect(Object.keys(legacyFiles()).sort()).toEqual(
			[
				"alert-desk.json",
				"compact-url",
				"daemon.env",
				"decision-rights.md",
				"decisions-thread",
				"desk-thread",
				"desk-wake-url",
				"laptop-operate-token",
				"laptop-token",
				"main-token",
				"desktop-operate-token",
				"desktop-token",
				"operating-rules.json",
				"servers.json",
				"settings.json",
				"steward-thread",
				"sweep.json",
				"t3-operate-token",
				"wake-url",
				"web.json",
			].sort(),
		);
	});

	test("every value lands where it should, and the old files are MOVED: no stale copy is left at an old name", () => {
		const conf = fresh();
		const names = writeLegacyConf(conf);
		const before = Object.fromEntries(names.map((n) => [n, readFileSync(`${conf}/${n}`, "utf8")]));

		const r = migrateLayout(conf);
		expect(r.skipped).toBeUndefined();
		expect(r.changed).toBe(true);
		expect(r.plan.problems).toEqual([]);

		// config.json: 0600, versioned, and holds each non-secret setting under its new key
		expect(mode(`${conf}/config.json`)).toBe(0o600);
		const c = json(`${conf}/config.json`);
		expect(c.schemaVersion).toBe(1);
		expect(c.principal).toBe(SETTINGS.principalName); // settings.json principalName
		expect(c.t3Dir).toBe(SETTINGS.t3BaseDir); // settings.json t3BaseDir
		expect(c.alertCmd).toBe(SETTINGS.alertCommand); // settings.json alertCommand wins over daemon.env's
		expect(c.compactTokens).toBe(SETTINGS.compactTokens);
		expect(c.settledMatch).toEqual(SETTINGS.settledMatch);
		expect(c.recover).toBe(true); // daemon.env CHAMBERLAIN_RECOVER=1
		expect(c.reportQuietMs).toBe(90000); // daemon.env CHAMBERLAIN_REPORT_QUIET_MS, quotes stripped
		expect(c.servers).toEqual(SERVERS.servers);
		expect(c.web).toEqual((({ schemaVersion: _s, ...w }) => w)(WEB));
		expect(c.sweep).toEqual({ checks: SWEEP.checks });
		expect(c.alertDesk).toEqual(ALERT_DESK);
		expect(c.operatingRules).toEqual((({ schemaVersion: _s, ...o }) => o)(OPERATING_RULES));
		expect(c.threads).toEqual({
			steward: FAKE.stewardThread,
			decisions: FAKE.decisionsThread,
			desk: FAKE.deskThread,
		});
		expect(c.migrated.files).toContain("settings.json");
		// nothing secret is in config.json
		const text = readFileSync(`${conf}/config.json`, "utf8");
		for (const v of [FAKE.wakeUrl, FAKE.compactUrl, FAKE.deskWakeUrl, ...Object.values(TOKENS)])
			expect(text).not.toContain(v);

		// secrets/: a 0700 directory of 0600 files, one per secret, same name, same content
		expect(mode(`${conf}/secrets`)).toBe(0o700);
		const secretFiles: Record<string, string> = {
			"wake-url": FAKE.wakeUrl,
			"compact-url": FAKE.compactUrl,
			"desk-wake-url": FAKE.deskWakeUrl,
			...TOKENS,
		};
		expect(Object.keys(secretFiles)).toHaveLength(9);
		for (const [name, value] of Object.entries(secretFiles)) {
			expect(mode(`${conf}/secrets/${name}`)).toBe(0o600);
			expect(readFileSync(`${conf}/secrets/${name}`, "utf8")).toBe(`${value}\n`);
		}
		// the prose and systemd's file stay files, and are not moved
		for (const n of ["decision-rights.md", "daemon.env"]) expect(existsSync(`${conf}/secrets/${n}`)).toBe(false);
		expect(readFileSync(`${conf}/decision-rights.md`, "utf8")).toBe(DECISION_RIGHTS);
		expect(readFileSync(`${conf}/daemon.env`, "utf8")).toBe(DAEMON_ENV);

		// no stale copy: a secret is gone from its old name; each migrated non-secret file is set aside whole as <name>.migrated
		for (const n of Object.keys(secretFiles)) expect(existsSync(`${conf}/${n}`), n).toBe(false);
		const setAside = names.filter((n) => !(n in secretFiles) && n !== "decision-rights.md" && n !== "daemon.env");
		expect(setAside).toHaveLength(9);
		for (const n of setAside) {
			expect(existsSync(`${conf}/${n}`), n).toBe(false);
			expect(readFileSync(`${conf}/${n}.migrated`, "utf8"), n).toBe(before[n]!); // nothing is lost, not even a key this build never read
		}
		expect([...c.migrated.files].sort()).toEqual([...Object.keys(secretFiles), ...setAside].sort());

		// the difference between settings.json and daemon.env is reported, not resolved
		expect(r.plan.differs.map((d) => d.key)).toContain("alertCmd");
	});

	test("the new layout alone serves every reader", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		expect(readFileSync(`${conf}/decision-rights.md`, "utf8")).toBe(DECISION_RIGHTS);

		expect(readServers(conf)!.map((s) => s.name)).toEqual(["main", "laptop", "desktop"]);
		expect(readServers(conf)![1]).toMatchObject({
			environmentId: "fake-env-laptop",
			mayBeOffline: true,
			tokenFile: "laptop-token",
		});
		expect(loadConfig(conf)).toMatchObject({ host: "127.0.0.1", port: 3790, allowedHosts: ["fake-host.example"] });
		expect(loadConfig(conf).answerTokens).toEqual({ laptop: "laptop-operate-token", desktop: "desktop-operate-token" });
		expect(loadConfig(conf).decisionsServer).toEqual(WEB.decisionsServer);
		expect(readSweepConfig(conf).checks.map((c) => c.name)).toEqual(["disk"]);
		expect(readConfig(conf)).toMatchObject({ dailyCap: 9, morningHour: 6 });
		expect(readOperator(conf).morning.commands).toEqual(ALERT_DESK.morningCommands);
		expect(readOperator(conf).gatherer).toBe("fake-gatherer");
		expect(cfg(conf, "operatingRules")).toMatchObject({ intro: "Fake intro." });
		expect(thread(conf, "steward")).toBe(FAKE.stewardThread);
		expect(readNamed(conf, "decisions-thread")).toBe(FAKE.decisionsThread);
		expect(readNamed(conf, "desk-thread")).toBe(FAKE.deskThread);
		expect(readNamed(conf, "wake-url")).toBe(FAKE.wakeUrl);
		expect(readNamed(conf, "compact-url")).toBe(FAKE.compactUrl);
		expect(readNamed(conf, "desk-wake-url")).toBe(FAKE.deskWakeUrl);
		for (const [name, value] of Object.entries(TOKENS)) expect(readSecret(conf, name)).toBe(value);
		expect(readNamed(conf, "decision-rights.md")).toBe(DECISION_RIGHTS.trim());
		expect(setting("principal", conf, NONE)).toBe("Ada");
		expect(setting("recover", conf, NONE)).toBe(true);
	});

	test("a second run does nothing, and a dry run writes nothing", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		const dry = migrateLayout(conf, { dryRun: true });
		expect(dry.changed).toBe(false);
		expect(existsSync(`${conf}/config.json`)).toBe(false);
		expect(existsSync(`${conf}/secrets`)).toBe(false);
		expect(dry.plan.added.length).toBeGreaterThan(10);
		expect(dry.plan.secrets.filter((s) => s.action === "move")).toHaveLength(9);
		expect(dry.plan.renames).toHaveLength(9);
		// the dry-run text names keys and files and never a value
		const text = planLines(dry.plan, { dryRun: true }).join("\n");
		for (const v of [FAKE.wakeUrl, FAKE.compactUrl, FAKE.deskWakeUrl, FAKE.stewardThread, ...Object.values(TOKENS)])
			expect(text).not.toContain(v);
		expect(text).toContain("secrets/wake-url: would move");
		expect(text).toContain("settings.json: would be set aside as settings.json.migrated");

		expect(migrateLayout(conf).changed).toBe(true);
		const again = migrateLayout(conf);
		expect(again.changed).toBe(false);
		expect(again.plan.writeConfig).toBe(false);
		expect(again.plan.added).toEqual([]);
		expect(again.plan.secrets).toEqual([]);
		expect(again.plan.renames).toEqual([]);
		expect(planLines(again.plan, { dryRun: false }).join("\n")).toContain("nothing to do");
	});

	test("it never overwrites, and an old name written again after the move is never read", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		writeFileSync(`${conf}/settings.json`, `${JSON.stringify({ ...SETTINGS, principalName: "Someone Else" })}\n`, {
			mode: 0o600,
		});
		writeFileSync(`${conf}/wake-url`, "https://fake.example/hooks/CHANGED\n", { mode: 0o600 });
		const r = migrateLayout(conf);
		expect(r.changed).toBe(false);
		expect(r.plan.reappeared.sort()).toEqual(["settings.json", "wake-url"]);
		expect(r.plan.secrets.find((s) => s.name === "wake-url")?.action).toBe("differs");
		expect(setting("principal", conf, NONE)).toBe("Ada");
		expect(readSecret(conf, "wake-url")).toBe(FAKE.wakeUrl);
	});

	test("a secret that is not 0600 is not moved, and the rest still migrates", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		chmodSync(`${conf}/laptop-token`, 0o644);
		const r = migrateLayout(conf);
		expect(existsSync(`${conf}/secrets/laptop-token`)).toBe(false);
		expect(existsSync(`${conf}/laptop-token`)).toBe(true); // left where it is, never read at that mode
		expect(existsSync(`${conf}/secrets/desktop-token`)).toBe(true);
		expect(r.plan.problems.join("\n")).toContain("laptop-token");
		expect(existsSync(`${conf}/config.json`)).toBe(true);
	});

	test("an alert-desk.json that others can write is not trusted into config.json", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		chmodSync(`${conf}/alert-desk.json`, 0o666);
		const r = migrateLayout(conf);
		expect(json(`${conf}/config.json`).alertDesk).toBeUndefined();
		expect(r.plan.problems.join("\n")).toContain("alert-desk.json");
	});

	test("a token file named by the config is migrated whatever it is called", () => {
		const conf = fresh();
		writeFileSync(
			`${conf}/servers.json`,
			JSON.stringify({
				schemaVersion: 2,
				servers: [{ name: "a", adapter: "t3", origin: "http://x", tokenFile: "odd.txt" }],
			}),
			{ mode: 0o600 },
		);
		writeFileSync(`${conf}/odd.txt`, "fake-odd\n", { mode: 0o600 });
		migrateLayout(conf);
		expect(readFileSync(`${conf}/secrets/odd.txt`, "utf8")).toBe("fake-odd\n");
	});

	test("config show names every key and secret with where it comes from, and prints no secret", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		const text = showLines(conf, NONE).join("\n");
		expect(text).toContain("principal");
		expect(text).toContain("(config.json)");
		expect(text).toContain("servers");
		expect(text).toContain("main, laptop, desktop");
		expect(text).toContain("secrets/");
		expect(text).toContain("wake-url");
		for (const v of [FAKE.wakeUrl, FAKE.compactUrl, ...Object.values(TOKENS)]) expect(text).not.toContain(v);
	});
});

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

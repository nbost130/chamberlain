import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { useCoreConfigMigrateFixtures } from "../../testing/core-config-migrate-fixtures.ts";
import {
	ALERT_DESK,
	DAEMON_ENV,
	DECISION_RIGHTS,
	FAKE,
	legacyFiles,
	OPERATING_RULES,
	SERVERS,
	SETTINGS,
	SWEEP,
	WEB,
	writeLegacyConf,
} from "../../testing/legacy-conf.ts";
import { loadConfig } from "../../web/config.ts";
import { readConfig } from "../desk/alert-desk-config.ts";
import { readOperator } from "../desk/alert-desk-prompt.ts";
import { readSweepConfig } from "../sweep/sweep.ts";
import { planLines, showLines } from "./config-cmd.ts";
import { migrateLayout } from "./config-migrate.ts";
import { cfg, readNamed, readSecret, setting, thread } from "./layout.ts";
import { readServers } from "./servers.ts";

const { TOKENS, fresh, mode, json, NONE } = useCoreConfigMigrateFixtures();

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

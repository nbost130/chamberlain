/** config-move, continued: see config-move.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { useCoreConfigMoveFixtures } from "../testing/core-config-move-fixtures.ts";
import { FAKE, writeLegacyConf } from "../testing/legacy-conf.ts";
import { showLines } from "./config-cmd.ts";
import { migrateLayout, startupLayout } from "./config-migrate.ts";
import { revertLayout } from "./config-revert.ts";
import { readSecret, thread } from "./layout.ts";
import { reappearedFiles } from "./layout-legacy.ts";
import { readConfigFile } from "./layout-read.ts";

const { fresh, NONE, SECRET_NAMES } = useCoreConfigMoveFixtures();

describe("the last five (a final check of the move)", () => {
	const crashAt = (want: string) => (s: string) => {
		if (s === want) throw Error("crash");
	};

	test("1. a revert that crashed after config.json went aside, then a daemon start, still moves every secret back on the next revert", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		expect(() => revertLayout(conf, { afterStep: crashAt("config") })).toThrow("crash");
		expect(readdirSync(`${conf}/secrets`).sort()).toEqual([...SECRET_NAMES].sort()); // still all in secrets/
		startupLayout(conf, () => {}); // the daemon starts: config.json is absent, so it migrates the restored files again
		expect(existsSync(`${conf}/config.json`)).toBe(true);
		revertLayout(conf);
		for (const n of SECRET_NAMES) expect(existsSync(`${conf}/${n}`), n).toBe(true);
		expect(readdirSync(`${conf}/secrets`)).toEqual([]);
	});

	test("1b. a crash partway through the secrets of a revert, then a daemon start, then a revert: nothing is stranded", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		expect(() => revertLayout(conf, { afterStep: crashAt(`secret:${SECRET_NAMES[3]}`) })).toThrow("crash");
		startupLayout(conf, () => {});
		revertLayout(conf);
		expect(readdirSync(`${conf}/secrets`)).toEqual([]);
		for (const n of SECRET_NAMES) expect(existsSync(`${conf}/${n}`), n).toBe(true);
	});

	test("2. two crashed migrations and a clean one: the journal keeps the union, so every secret is in migrated.files and revert moves it back", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		// Each run crashes after the first secret it moves. Which secret that is depends on the order the directory lists them in (the
		// filesystem's), so the test names no secret: the second run finds the first one's secret already moved and crashes on another.
		const crashOnFirstSecret = (step: string) => {
			if (step.startsWith("secret:")) throw Error("crash");
		};
		for (let run = 0; run < 2; run++)
			expect(() => migrateLayout(conf, { afterStep: crashOnFirstSecret })).toThrow("crash");
		migrateLayout(conf);
		const files = (readConfigFile(conf)!.migrated as { files: string[] }).files;
		for (const n of SECRET_NAMES) expect(files, n).toContain(n);
		revertLayout(conf);
		expect(readdirSync(`${conf}/secrets`)).toEqual([]);
	});

	test("3. the command line prints revert's notes", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		const r = Bun.spawnSync(["bun", "src/cli.ts", "config", "revert"], {
			cwd: new URL("../..", import.meta.url).pathname,
			env: { ...process.env, CHAMBERLAIN_CONF: conf },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(r.exitCode).toBe(0);
		const out = r.stdout.toString();
		expect(out).toContain("note: settings edited in config.json since the migration are NOT in the restored files");
		expect(out).toContain("config.json.reverted");
	});

	test("4. deleting the .migrated files does not turn a reappeared file into a silent pending one: it is logged and not renamed away", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		for (const e of readdirSync(conf).filter((n) => n.endsWith(".migrated"))) rmSync(`${conf}/${e}`);
		writeFileSync(`${conf}/steward-thread`, "fake-retired-steward\n", { mode: 0o600 });
		const lines: [string, Record<string, unknown>?][] = [];
		startupLayout(conf, (e, d) => lines.push([e, d]));
		expect(lines.filter(([e]) => e === "config-legacy-reappeared").map(([, d]) => d!.file)).toEqual(["steward-thread"]);
		expect(existsSync(`${conf}/steward-thread`)).toBe(true); // not renamed away
		expect(existsSync(`${conf}/steward-thread.migrated`)).toBe(false);
		expect(thread(conf, "steward")).toBe(FAKE.stewardThread); // and never read
		expect(reappearedFiles(conf)).toEqual(["steward-thread"]);
	});

	test("4b. a file a crash left migrated but not yet renamed is still pending (finished silently), not reappeared", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		expect(() => migrateLayout(conf, { afterStep: crashAt("config") })).toThrow("crash");
		expect(reappearedFiles(conf)).toEqual([]);
		const lines: string[] = [];
		startupLayout(conf, (e) => lines.push(e));
		expect(lines).not.toContain("config-legacy-reappeared");
		expect(existsSync(`${conf}/steward-thread`)).toBe(false);
		expect(existsSync(`${conf}/steward-thread.migrated`)).toBe(true);
		expect(existsSync(`${conf}/.config-migrating`)).toBe(false); // the journal goes once every rename is done
	});

	test("5. a symlinked secret that crashed between its copy and its set-aside is in migrated.files, the next run finishes it, and a stale temp file is cleaned", () => {
		const conf = fresh();
		writeFileSync(`${conf}/real-hook`, "https://fake.example/linked\n", { mode: 0o600 });
		symlinkSync(`${conf}/real-hook`, `${conf}/wake-url`);
		expect(() => migrateLayout(conf, { afterStep: crashAt("secret-copied:wake-url") })).toThrow("crash");
		expect(lstatSync(`${conf}/wake-url`).isSymbolicLink()).toBe(true); // the link is still there
		writeFileSync(`${conf}/secrets/wake-url.tmp-99999`, "half", { mode: 0o600 });
		expect(showLines(conf, NONE).join("\n")).not.toContain("wake-url.tmp-99999");
		migrateLayout(conf);
		expect((readConfigFile(conf)!.migrated as { files: string[] }).files).toContain("wake-url");
		expect(existsSync(`${conf}/wake-url`)).toBe(false);
		expect(lstatSync(`${conf}/wake-url.migrated`).isSymbolicLink()).toBe(true);
		expect(existsSync(`${conf}/secrets/wake-url.tmp-99999`)).toBe(false);
		expect(readSecret(conf, "wake-url")).toBe("https://fake.example/linked");
		revertLayout(conf);
		expect(readdirSync(`${conf}/secrets`)).toEqual([]);
	});
});

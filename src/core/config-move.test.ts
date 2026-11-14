/**
 * The migration MOVES files, and the order of the moves is what makes a crash safe. These tests crash it after each step and check that every
 * value stays readable, that a re-run finishes the job, that an old name written again afterwards is never read, and that `config revert` puts
 * everything back (and survives a crash of its own).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { useCoreConfigMoveFixtures } from "../testing/core-config-move-fixtures.ts";
import { FAKE, tokensFor, writeLegacyConf } from "../testing/legacy-conf.ts";
import { getValue, reappearedLine, showLines } from "./config-cmd.ts";
import { migrateLayout, setThread, startupLayout } from "./config-migrate.ts";
import { readNamed, readSecret, thread } from "./layout.ts";
import { reappearedFiles, resetLayout } from "./layout-legacy.ts";

const { fresh, NONE, snap, treeSafe, stepsOf } = useCoreConfigMoveFixtures();

describe("a crash at any point of the migration loses no value", () => {
	const steps = stepsOf();
	test("the steps are the nine secrets, then config.json, then the nine renames", () => {
		expect(steps.filter((s) => s.startsWith("secret:"))).toHaveLength(9);
		expect(steps.indexOf("config")).toBe(9);
		expect(steps.filter((s) => s.startsWith("rename:"))).toHaveLength(9);
		expect(steps).toHaveLength(19);
	});
	for (let k = 0; k < steps.length; k++) {
		test(`crash after step ${k + 1} (${steps[k]}): every value is still read, and a re-run finishes the job`, () => {
			const conf = fresh();
			writeLegacyConf(conf);
			const expected = snap(conf); // read from the old layout, before anything moves
			let n = 0;
			expect(() =>
				migrateLayout(conf, {
					afterStep: () => {
						if (n++ === k) throw Error("crash");
					},
				}),
			).toThrow("crash");
			resetLayout();
			expect(snap(conf)).toEqual(expected);

			// the next start finishes it: the same end state as a run that was never interrupted
			const logged: string[] = [];
			startupLayout(conf, (e) => logged.push(e));
			const whole = fresh();
			writeLegacyConf(whole);
			migrateLayout(whole);
			expect(treeSafe(conf)).toEqual(treeSafe(whole));
			resetLayout();
			expect(snap(conf)).toEqual(expected);
			// and nothing is flagged as a stray old file
			expect(reappearedFiles(conf)).toEqual([]);
			expect(migrateLayout(conf).changed).toBe(false);
		});
	}
});

describe("an old name written again after the move is never read", () => {
	test("a retired Steward's thread id, and a re-minted token, are ignored; the value is where it moved to", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		// an outside tool writes the old names
		writeFileSync(`${conf}/steward-thread`, "fake-retired-steward\n", { mode: 0o600 });
		writeFileSync(`${conf}/laptop-token`, "fake-reminted-token\n", { mode: 0o600 });
		expect(thread(conf, "steward")).toBe("fake-new-steward");
		expect(readNamed(conf, "steward-thread")).toBe("fake-new-steward");
		expect(readSecret(conf, "laptop-token")).toBe(tokensFor()["laptop-token"]!);
		// the daemon's start says so, once per file, without a value
		const seen: [string, Record<string, unknown>][] = [];
		startupLayout(conf, (e, d) => seen.push([e, d ?? {}]));
		expect(seen.map(([e]) => e).sort()).toEqual(["config-legacy-reappeared", "config-legacy-reappeared"]);
		expect(seen.map(([, d]) => d.file).sort()).toEqual(["laptop-token", "steward-thread"]);
		expect(String(seen.find(([, d]) => d.file === "steward-thread")![1].now)).toContain("threads.steward");
		expect(JSON.stringify(seen)).not.toContain("fake-reminted-token");
		expect(JSON.stringify(seen)).not.toContain("fake-retired-steward");
	});
	test("a secret deleted from secrets/ is not revived from a same-named old file", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		rmSync(`${conf}/secrets/laptop-token`);
		writeFileSync(`${conf}/laptop-token`, "fake-old-again\n", { mode: 0o600 });
		expect(readSecret(conf, "laptop-token")).toBeUndefined();
	});
	test("the daemon's start logs it once per file, and `config show` flags each in a line that says where the value lives now", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		writeFileSync(`${conf}/steward-thread`, "fake-retired-steward\n", { mode: 0o600 });
		writeFileSync(`${conf}/laptop-token`, "fake-reminted-token\n", { mode: 0o600 });
		const lines: [string, Record<string, unknown>?][] = [];
		startupLayout(conf, (e, d) => lines.push([e, d]));
		startupLayout(conf, (e, d) => lines.push([e, d]));
		const re = lines.filter(([e]) => e === "config-legacy-reappeared");
		expect(re.map(([, d]) => d!.file).sort()).toEqual(["laptop-token", "steward-thread"]);
		const show = showLines(conf, NONE);
		expect(show).toContain(reappearedLine("steward-thread"));
		expect(show).toContain(reappearedLine("laptop-token"));
		expect(reappearedLine("steward-thread")).toBe(
			'REAPPEARED  steward-thread: written at its old place after the migration, and NEVER read. The value lives in config.json "threads.steward" (read it with: chamberlain config get threads.steward). Change settings in config.json.',
		);
		expect(reappearedLine("laptop-token")).toBe(
			"REAPPEARED  laptop-token: written at its old place after the migration, and NEVER read. The secret lives in secrets/laptop-token. Mint new secrets into secrets/<name>, not at the old path.",
		);
		expect(show.join("\n")).not.toContain("fake-reminted-token");
		// and the old names are not listed as secrets still read from the old place
		expect(show.join("\n")).not.toMatch(/laptop-token\s+config directory/);
	});
	test("a file that was never migrated (a problem stopped it) is still read as a fallback", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		writeFileSync(`${conf}/judge.json`, JSON.stringify({ triggers: {}, backends: {} }), { mode: 0o644 }); // not 0600: never migrated
		migrateLayout(conf);
		writeFileSync(`${conf}/new-token`, "fake-new\n", { mode: 0o600 }); // a secret dropped in later, never migrated
		expect(readSecret(conf, "new-token")).toBe("fake-new");
		expect(reappearedFiles(conf)).toEqual([]);
	});
});

describe("chamberlain config get", () => {
	test("prints one value for a script: a thread, a scalar, a path into a section, a list entry", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		expect(getValue("threads.steward", conf, NONE)).toEqual({ ok: true, text: "fake-new-steward" });
		expect(getValue("threads.decisions", conf, NONE)).toEqual({ ok: true, text: FAKE.decisionsThread });
		expect(getValue("principal", conf, NONE)).toEqual({ ok: true, text: "Ada" });
		expect(getValue("principal", conf, { CHAMBERLAIN_PRINCIPAL: "Env" })).toEqual({ ok: true, text: "Env" });
		expect(getValue("compactTokens", conf, NONE)).toEqual({ ok: true, text: "123456" });
		expect(getValue("web.port", conf, NONE)).toEqual({ ok: true, text: "3790" });
		expect(getValue("servers.1.name", conf, NONE)).toEqual({ ok: true, text: "laptop" });
		expect(getValue("settledMatch", conf, NONE)).toEqual({
			ok: true,
			text: '{"titleOverlap":false,"ignoreWords":["acme"]}',
		});
	});
	test("refuses a secret, by name and by the secrets/ directory", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		for (const k of ["wake-url", "laptop-token", "laptop-operate-token", "secrets.laptop-token", "secrets"]) {
			const r = getValue(k, conf, NONE);
			expect(r.ok, k).toBe(false);
			expect((r as { error: string }).error, k).toContain("secret");
		}
	});
	test("an unset key, an unknown one and a malformed one are errors with nothing to print", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		expect(getValue("stallMs", conf, NONE)).toEqual({ ok: false, error: "stallMs: not set" });
		expect(getValue("nonsense.key", conf, NONE).ok).toBe(false);
		expect(getValue("threads.nobody", conf, NONE).ok).toBe(false);
		expect(getValue("", conf, NONE).ok).toBe(false);
		expect(getValue("a..b", conf, NONE).ok).toBe(false);
	});
});

describe("the command line", () => {
	const run = (conf: string, ...args: string[]) => {
		const r = Bun.spawnSync(["bun", "src/cli.ts", "config", ...args], {
			cwd: new URL("../..", import.meta.url).pathname,
			env: { ...process.env, CHAMBERLAIN_CONF: conf },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
	};
	test("get prints a value and exits 0; an unset key or a secret prints nothing and exits 1 (the tool's exit code is not lost)", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		expect(run(conf, "get", "threads.steward")).toEqual({ code: 0, out: `${FAKE.stewardThread}\n`, err: "" });
		const secret = run(conf, "get", "wake-url");
		expect([secret.code, secret.out]).toEqual([1, ""]);
		expect(secret.err).toContain("names a secret");
		const unset = run(conf, "get", "stallMs");
		expect([unset.code, unset.out]).toEqual([1, ""]);
		expect(run(conf, "get").code).toBe(2);
	});
	test("migrate, revert and show run end to end, and revert twice says there is nothing to revert", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		expect(run(conf, "migrate", "--dry-run").out).toContain("would move");
		expect(existsSync(`${conf}/wake-url`)).toBe(true);
		expect(run(conf, "migrate").code).toBe(0);
		expect(existsSync(`${conf}/wake-url`)).toBe(false);
		expect(run(conf, "show").out).toContain("(config.json)");
		expect(run(conf, "revert").code).toBe(0);
		expect(existsSync(`${conf}/wake-url`)).toBe(true);
		expect(run(conf, "revert").out).toContain("nothing to revert");
	});
});

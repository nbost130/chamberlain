/**
 * The migration MOVES files, and the order of the moves is what makes a crash safe. These tests crash it after each step and check that every
 * value stays readable, that a re-run finishes the job, that an old name written again afterwards is never read, and that `config revert` puts
 * everything back (and survives a crash of its own).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	lstatSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { FAKE, legacyFiles, tokensFor, writeLegacyConf } from "../testing/legacy-conf.ts";
import { loadConfig } from "../web/config.ts";
import { readConfig } from "./alert-desk.ts";
import { assertSupported } from "./migrate.ts";
import { getValue, reappearedLine, showLines } from "./config-cmd.ts";
import { migrateLayout, revertLayout, setThread, startupLayout } from "./config-migrate.ts";
import {
	THREADS,
	attachDeprecationLog,
	cfg,
	readConfigFile,
	readNamed,
	readSecret,
	reappearedFiles,
	resetLayout,
	setting,
	thread,
} from "./layout.ts";
import { readServers } from "./servers.ts";
import { readSweepConfig } from "./sweep.ts";

const dirs: string[] = [];
const fresh = () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-move-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	mkdirSync(conf, { mode: 0o700 });
	return conf;
};
afterEach(() => {
	resetLayout();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NONE = {} as Record<string, string | undefined>;
const SECRET_NAMES = Object.keys(legacyFiles()).filter((n) => /(^|-)(token|url)$/.test(n));

/** Every value a reader returns, from whatever layout the directory is in now. */
function snap(conf: string) {
	return {
		principal: setting("principal", conf, NONE),
		compact: setting("compactTokens", conf, NONE),
		servers: readServers(conf)?.map((s) => `${s.name}:${String(s.tokenFile)}`),
		web: loadConfig(conf).port,
		answerTokens: loadConfig(conf).answerTokens,
		sweep: readSweepConfig(conf).checks.map((c) => c.name),
		desk: readConfig(conf).dailyCap,
		rules: cfg(conf, "operatingRules"),
		threads: THREADS.map((m) => thread(conf, m)),
		secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, readNamed(conf, n)])),
		rights: readNamed(conf, "decision-rights.md"),
	};
}
const tree = (conf: string) =>
	[...readdirSync(conf), ...readdirSync(`${conf}/secrets`).map((n) => `secrets/${n}`)].sort();
const treeSafe = (conf: string) => (existsSync(`${conf}/secrets`) ? tree(conf) : readdirSync(conf).sort());

/** The steps one migration takes, in order: a dry list made by running it for real in a throwaway directory. */
function stepsOf(): string[] {
	const conf = fresh();
	writeLegacyConf(conf);
	const steps: string[] = [];
	migrateLayout(conf, { afterStep: (s) => steps.push(s) });
	return steps;
}

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

describe("chamberlain config revert", () => {
	test("puts every old file back byte for byte, moves the secrets back with their dates, and sets config.json aside", () => {
		const conf = fresh();
		const names = writeLegacyConf(conf);
		const before = Object.fromEntries(names.map((n) => [n, readFileSync(`${conf}/${n}`, "utf8")]));
		const old = new Date(Date.now() - 40 * 86_400_000);
		for (const n of SECRET_NAMES) utimesSync(`${conf}/${n}`, old, old);
		const expected = snap(conf);
		migrateLayout(conf);

		const r = revertLayout(conf);
		expect(r.problems).toEqual([]);
		for (const n of names) expect(readFileSync(`${conf}/${n}`, "utf8"), n).toBe(before[n]!);
		for (const n of SECRET_NAMES) expect(Math.abs(statSync(`${conf}/${n}`).mtimeMs - old.getTime()), n).toBeLessThan(2);
		expect(existsSync(`${conf}/config.json`)).toBe(false);
		expect(existsSync(`${conf}/config.json.reverted`)).toBe(true);
		expect(readdirSync(`${conf}/secrets`)).toEqual([]);
		expect(readdirSync(conf).filter((n) => n.endsWith(".migrated"))).toEqual([]);
		resetLayout();
		expect(snap(conf)).toEqual(expected); // an older build reads it all again
	});
	test("is idempotent: a second run finds nothing to do and touches nothing", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		revertLayout(conf);
		const state = treeSafe(conf);
		writeFileSync(`${conf}/steward-thread`, "fake-set-by-an-older-build\n", { mode: 0o600 });
		const again = revertLayout(conf);
		expect(again.done).toEqual(["nothing to revert"]);
		expect(treeSafe(conf)).toEqual(state);
		expect(readFileSync(`${conf}/steward-thread`, "utf8").trim()).toBe("fake-set-by-an-older-build");
		expect(revertLayout(conf, { dryRun: true }).done).toEqual(["nothing to revert"]);
	});
	test("after a Steward switch it writes the CURRENT thread id, never the retired one", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		revertLayout(conf);
		expect(readFileSync(`${conf}/steward-thread`, "utf8").trim()).toBe("fake-new-steward");
		expect(readFileSync(`${conf}/decisions-thread`, "utf8").trim()).toBe(FAKE.decisionsThread);
	});
	test("an old name written after the migration is set aside as .reappeared, never overwritten or lost", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		writeFileSync(`${conf}/settings.json`, '{"principalName":"Someone"}\n', { mode: 0o600 });
		writeFileSync(`${conf}/laptop-token`, "fake-reminted-token\n", { mode: 0o600 });
		revertLayout(conf);
		expect(readFileSync(`${conf}/settings.json.reappeared`, "utf8")).toContain("Someone");
		expect(readFileSync(`${conf}/laptop-token.reappeared`, "utf8").trim()).toBe("fake-reminted-token");
		expect(readFileSync(`${conf}/laptop-token`, "utf8").trim()).toBe(tokensFor()["laptop-token"]!);
	});
	test("a dry run says what it would do and changes nothing", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		const state = treeSafe(conf);
		const r = revertLayout(conf, { dryRun: true });
		expect(r.done.length).toBeGreaterThan(10);
		expect(r.done.every((l) => l.startsWith("would "))).toBe(true);
		expect(treeSafe(conf)).toEqual(state);
	});

	const revertSteps = (() => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		const steps: string[] = [];
		revertLayout(conf, { afterStep: (s) => steps.push(s) });
		return steps;
	})();
	for (let k = 0; k < revertSteps.length; k++) {
		test(`a crash after revert step ${k + 1} (${revertSteps[k]}) loses no value, and a second run finishes`, () => {
			const conf = fresh();
			writeLegacyConf(conf);
			migrateLayout(conf);
			setThread(conf, "steward", "fake-new-steward");
			resetLayout();
			const expected = snap(conf);
			let n = 0;
			expect(() =>
				revertLayout(conf, {
					afterStep: () => {
						if (n++ === k) throw Error("crash");
					},
				}),
			).toThrow("crash");
			resetLayout();
			expect(snap(conf)).toEqual(expected);
			revertLayout(conf);
			resetLayout();
			expect(snap(conf)).toEqual(expected);
			expect(existsSync(`${conf}/config.json`)).toBe(false);
			expect(readdirSync(`${conf}/secrets`)).toEqual([]);
			expect(readdirSync(conf).filter((x) => x.endsWith(".migrated"))).toEqual([]);
			expect(revertLayout(conf).done).toEqual(["nothing to revert"]);
		});
	}
});

describe("what the audit of the first version found", () => {
	const archive = (conf: string, name: string) => readFileSync(`${conf}/${name}`, "utf8").trim();

	test("revert never replaces a file it set aside before: two reappeared writes keep both, and several archives keep the older ones", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		writeFileSync(`${conf}/settings.json`, '{"principalName":"First"}\n', { mode: 0o600 });
		revertLayout(conf);
		expect(archive(conf, "settings.json.reappeared")).toContain("First");
		migrateLayout(conf); // a second cycle from the restored old layout
		writeFileSync(`${conf}/settings.json`, '{"principalName":"Second"}\n', { mode: 0o600 });
		revertLayout(conf);
		expect(archive(conf, "settings.json.reappeared")).toContain("First"); // not replaced
		expect(archive(conf, "settings.json.reappeared.1")).toContain("Second");
		// two archives of one file: the newest comes back, the older is kept
		const c2 = fresh();
		writeLegacyConf(c2);
		migrateLayout(c2);
		writeFileSync(`${c2}/judge.json.migrated.1`, '{"newer":true}\n', { mode: 0o600 });
		writeFileSync(`${c2}/judge.json.migrated`, '{"older":true}\n', { mode: 0o600 });
		revertLayout(c2);
		expect(archive(c2, "judge.json")).toContain("newer");
		expect(archive(c2, "judge.json.migrated.earlier")).toContain("older");
	});

	test("a secret that is a symlink to another secret still gets its content, whichever moves first", () => {
		const conf = fresh();
		writeFileSync(`${conf}/read-token`, "fake-read-token\n", { mode: 0o600 });
		symlinkSync(`${conf}/read-token`, `${conf}/wake-url`);
		expect(() => migrateLayout(conf)).not.toThrow();
		expect(readSecret(conf, "wake-url")).toBe("fake-read-token");
		expect(readSecret(conf, "read-token")).toBe("fake-read-token");
		expect(existsSync(`${conf}/wake-url`)).toBe(false);
	});

	test("a crash after a secret moved, before config.json: the journal keeps it in the list, and revert can move it back", () => {
		const conf = fresh();
		writeFileSync(`${conf}/wake-url`, `${FAKE.wakeUrl}\n`, { mode: 0o600 }); // a secret-only install: nothing else says it was migrated
		expect(() =>
			migrateLayout(conf, {
				afterStep: (s) => {
					if (s === "secret:wake-url") throw Error("crash");
				},
			}),
		).toThrow("crash");
		expect(existsSync(`${conf}/config.json`)).toBe(false);
		expect(readSecret(conf, "wake-url")).toBe(FAKE.wakeUrl); // readable
		// revert with no config.json at all still puts the secret back
		const c2 = fresh();
		writeFileSync(`${c2}/wake-url`, `${FAKE.wakeUrl}\n`, { mode: 0o600 });
		expect(() =>
			migrateLayout(c2, {
				afterStep: (s) => {
					if (s === "secret:wake-url") throw Error("crash");
				},
			}),
		).toThrow();
		revertLayout(c2);
		expect(archive(c2, "wake-url")).toBe(FAKE.wakeUrl);
		expect(existsSync(`${c2}/secrets/wake-url`)).toBe(false);
		// and a re-run of the migration lists it
		const r = migrateLayout(conf);
		expect(r.plan.config.migrated).toMatchObject({ files: ["wake-url"] });
		expect(readConfigFile(conf)!.migrated).toMatchObject({ files: ["wake-url"] });
		expect(existsSync(`${conf}/.config-migrating`)).toBe(false);
	});

	test("the list a crash-and-finish ends with is the list an uninterrupted run writes", () => {
		for (const k of [0, 4, 9, 12]) {
			const a = fresh();
			writeLegacyConf(a);
			let n = 0;
			expect(() =>
				migrateLayout(a, {
					afterStep: () => {
						if (n++ === k) throw Error("crash");
					},
				}),
			).toThrow();
			migrateLayout(a);
			const b = fresh();
			writeLegacyConf(b);
			migrateLayout(b);
			expect([...(readConfigFile(a)!.migrated as { files: string[] }).files].sort()).toEqual(
				[...(readConfigFile(b)!.migrated as { files: string[] }).files].sort(),
			);
		}
	});

	test("revert never replaces a thread file: a meanwhile-written one and the restored old id are kept as .reappeared and .pre-revert", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		writeFileSync(`${conf}/steward-thread`, "fake-outside-write\n", { mode: 0o600 });
		revertLayout(conf);
		expect(archive(conf, "steward-thread")).toBe("fake-new-steward");
		expect(archive(conf, "steward-thread.reappeared")).toBe("fake-outside-write");
		expect(archive(conf, "steward-thread.pre-revert")).toBe(FAKE.stewardThread);
	});

	test("a revert resumed after a crash reads the NEWEST config.json.reverted, so a later cycle's secrets are moved back too", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		revertLayout(conf); // cycle one leaves config.json.reverted
		writeFileSync(`${conf}/extra-token`, "fake-extra\n", { mode: 0o600 }); // a secret only the second cycle moves
		migrateLayout(conf);
		expect(() =>
			revertLayout(conf, {
				afterStep: (s) => {
					if (s === "config") throw Error("crash");
				},
			}),
		).toThrow();
		expect(existsSync(`${conf}/config.json.reverted.1`)).toBe(true);
		revertLayout(conf);
		expect(archive(conf, "extra-token")).toBe("fake-extra");
		expect(existsSync(`${conf}/secrets/extra-token`)).toBe(false);
	});

	test("a thread set to none in config.json stays none after revert (the retired id is not brought back)", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		const doc = readConfigFile(conf)!;
		writeFileSync(
			`${conf}/config.json`,
			JSON.stringify({ ...doc, threads: { ...(doc.threads as object), steward: null } }),
			{ mode: 0o600 },
		);
		revertLayout(conf);
		expect(existsSync(`${conf}/steward-thread`)).toBe(false);
		expect(archive(conf, "steward-thread.pre-revert")).toBe(FAKE.stewardThread);
		expect(archive(conf, "decisions-thread")).toBe(FAKE.decisionsThread);
		const c2 = fresh();
		writeLegacyConf(c2);
		migrateLayout(c2);
		writeFileSync(`${c2}/config.json`, JSON.stringify({ ...readConfigFile(c2)!, threads: null }), { mode: 0o600 });
		revertLayout(c2);
		for (const f of ["steward-thread", "decisions-thread", "desk-thread"])
			expect(existsSync(`${c2}/${f}`), f).toBe(false);
	});

	test("revert says that settings edited in config.json since the migration are not in the restored files", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		const r = revertLayout(conf);
		expect(r.notes.join("\n")).toContain("NOT in the restored files");
		expect(r.notes.join("\n")).toContain("config.json.reverted");
	});

	test("startup does not read a reappeared file: one with a newer schemaVersion cannot stop the start", () => {
		const conf = fresh();
		const state = `${conf}/../state`;
		mkdirSync(state, { recursive: true, mode: 0o700 });
		writeLegacyConf(conf);
		migrateLayout(conf);
		writeFileSync(`${conf}/settings.json`, JSON.stringify({ schemaVersion: 99, principalName: "x" }), { mode: 0o600 });
		expect(() => assertSupported({ conf, state })).not.toThrow();
		expect(assertSupported({ conf, state }).map((s) => s.what)).not.toContain("settings.json");
	});

	test("`config migrate` does not reinstate a retired Steward from a reappeared thread file", () => {
		const conf = fresh();
		writeLegacyConf(conf);
		migrateLayout(conf);
		setThread(conf, "steward", "fake-new-steward");
		writeFileSync(`${conf}/steward-thread`, "fake-retired-steward\n", { mode: 0o600 });
		const r = migrateLayout(conf);
		expect(r.plan.added.map((a) => a.key)).not.toContain("threads.steward");
		expect(thread(conf, "steward")).toBe("fake-new-steward");
	});

	test("a moved token file with a custom name (credential.md) that comes back is reported like the others", () => {
		const conf = fresh();
		writeFileSync(
			`${conf}/servers.json`,
			JSON.stringify({
				schemaVersion: 2,
				servers: [{ name: "a", adapter: "t3", origin: "http://x", tokenFile: "credential.md" }],
			}),
			{ mode: 0o600 },
		);
		writeFileSync(`${conf}/credential.md`, "fake-md\n", { mode: 0o600 });
		migrateLayout(conf);
		writeFileSync(`${conf}/credential.md`, "fake-reminted\n", { mode: 0o600 });
		expect(reappearedFiles(conf)).toContain("credential.md");
		expect(readSecret(conf, "credential.md")).toBe("fake-md");
	});
});

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
		for (let run = 0; run < 2; run++)
			expect(() =>
				migrateLayout(conf, { afterStep: crashAt(run === 0 ? "secret:wake-url" : "secret:compact-url") }),
			).toThrow("crash");
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

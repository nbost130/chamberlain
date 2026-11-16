/** config-move, continued: see config-move.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { useCoreConfigMoveFixtures } from "../../testing/core-config-move-fixtures.ts";
import { FAKE, writeLegacyConf } from "../../testing/legacy-conf.ts";
import { migrateLayout, setThread } from "./config-migrate.ts";
import { revertLayout } from "./config-revert.ts";
import { readSecret, thread } from "./layout.ts";
import { reappearedFiles } from "./layout-legacy.ts";
import { readConfigFile } from "./layout-read.ts";
import { assertSupported } from "./migrate.ts";

const { fresh } = useCoreConfigMoveFixtures();

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

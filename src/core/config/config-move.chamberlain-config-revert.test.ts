/** config-move, continued: see config-move.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { useCoreConfigMoveFixtures } from "../../testing/core-config-move-fixtures.ts";
import { FAKE, tokensFor, writeLegacyConf } from "../../testing/legacy-conf.ts";
import { migrateLayout, setThread } from "./config-migrate.ts";
import { revertLayout } from "./config-revert.ts";
import { resetLayout } from "./layout-legacy.ts";

const { fresh, SECRET_NAMES, snap, treeSafe } = useCoreConfigMoveFixtures();

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

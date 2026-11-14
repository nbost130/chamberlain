/** The read-token age alarm stats the token where it lives now: `secrets/<name>`, after a migration that kept its date. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AdapterEnv } from "../../core/adapter.ts";
import { migrateLayout } from "../../core/config-migrate.ts";
import { resetLayout } from "../../core/layout-legacy.ts";
import { T3Link } from "./watch.ts";

const dirs: string[] = [];
afterEach(() => {
	resetLayout();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const aged = (days: number) => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-age-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	mkdirSync(conf, { mode: 0o700 });
	writeFileSync(`${conf}/laptop-token`, "fake-token\n", { mode: 0o600 });
	const t = new Date(Date.now() - days * 86_400_000);
	utimesSync(`${conf}/laptop-token`, t, t);
	const alarms: { key: string; title: string; summary: string }[] = [];
	const env = {
		conf,
		alarm: (key: string, title: string, summary: string) => alarms.push({ key, title, summary }),
	} as unknown as AdapterEnv;
	const link = new T3Link(env, {
		name: "laptop",
		adapter: "t3",
		origin: "http://127.0.0.1:1",
		tokenFile: "laptop-token",
	});
	return { conf, alarms, check: () => (link as unknown as { checkTokenAge(): void }).checkTokenAge() };
};

test("a token in secrets/ older than 30 days fires the alarm, naming secrets/<name>", () => {
	const w = aged(31);
	migrateLayout(w.conf); // a servers list is needed for the name to be a token file; the fixed pattern *-token is enough
	w.check();
	expect(w.alarms).toHaveLength(1);
	expect(w.alarms[0]!.key).toBe("token:laptop");
	expect(w.alarms[0]!.summary).toContain("31 days old");
	expect(w.alarms[0]!.summary).toContain("Mint a new one into secrets/laptop-token");
});
test("a young token does not alarm, and one never migrated is checked where it is, by its old name", () => {
	const young = aged(3);
	migrateLayout(young.conf);
	young.check();
	expect(young.alarms).toEqual([]);
	const old = aged(40);
	old.check(); // not migrated: the old place
	expect(old.alarms[0]!.summary).toContain("Mint a new one into laptop-token");
	expect(old.alarms[0]!.summary).not.toContain("secrets/");
});
test("the date survives the move, so a rename cannot hide an old token", () => {
	const w = aged(26);
	migrateLayout(w.conf);
	w.check();
	expect(w.alarms).toHaveLength(1); // 26 days > the 25-day threshold, in secrets/
});

/** migrate, continued: see migrate.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { useCoreMigrateFixtures } from "../../testing/core-migrate-fixtures.ts";
import { LATEST_MIGRATION } from "../store/migrations.ts";
import { SCHEMA_VERSION } from "../store/schema.ts";
import { openStore } from "../store/sqlite-store.ts";
import { dbPath } from "../store/store.ts";

const { world, put, oldInstall } = useCoreMigrateFixtures();

describe("entry points refuse a newer schema with exit code 3", () => {
	const run = async (script: string, w: { conf: string; state: string }, ...args: string[]) => {
		const p = Bun.spawn([process.execPath, new URL(script, import.meta.url).pathname, ...args], {
			env: { ...process.env, CHAMBERLAIN_CONF: w.conf, CHAMBERLAIN_STATE: w.state },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [err, code] = [await new Response(p.stderr).text(), await p.exited];
		return { err, code };
	};
	const TOOLS = [
		["../ops/decided.ts", ["t", "d", "R1"]],
		["../ops/ruling.ts", ["list"]],
		["../ops/butler.ts", ["list"]],
		["../ops/afk.ts", ["held"]],
	] as const;
	test("migrate.ts, the command-line tools and the daemon, for a config file from a newer build", async () => {
		const w = world();
		put(`${w.conf}/settings.json`, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
		for (const [script, args] of [["./migrate.ts", []], ...TOOLS] as const) {
			const r = await run(script, w, ...args);
			expect([script, r.code]).toEqual([script, 3]);
			expect(r.err).toContain(`settings.json has schemaVersion ${SCHEMA_VERSION + 1}`);
		}
		const d = await run("../../daemon.ts", w);
		expect(d.code).toBe(3);
		expect(d.err).toContain("newer Chamberlain");
	});
	test("the command-line tools and the daemon, for a database from a newer build", async () => {
		const w = world();
		openStore(dbPath(w.state)).close();
		const db = new Database(dbPath(w.state));
		db.run("INSERT INTO migrations (version, name, applied_at) VALUES (99, 'from the future', 'now')");
		db.close();
		for (const [script, args] of TOOLS) {
			const r = await run(script, w, ...args);
			expect([script, r.code]).toEqual([script, 3]);
			expect(r.err).toContain("migration 99");
			expect(r.err).toContain(`understands up to ${LATEST_MIGRATION}`);
		}
		const d = await run("../../daemon.ts", w);
		expect(d.code).toBe(3);
		expect(d.err).toContain("newer Chamberlain");
	});
	test("migrate.ts upgrades an old config directory from the command line", async () => {
		const w = world();
		oldInstall(w);
		const r = await run("./migrate.ts", w);
		expect(r.code).toBe(0);
		expect(JSON.parse(readFileSync(`${w.conf}/web.json`, "utf8")).schemaVersion).toBe(SCHEMA_VERSION);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertSupported, FILES, migrateStorage, STEPS, upgradeData } from "./migrate.ts";
import { readServers } from "./servers.ts";
import { holdFlock } from "./singleton.ts";
import { LATEST_MIGRATION } from "./migrations.ts";
import { openStore } from "./sqlite-store.ts";
import { dbPath } from "./store.ts";
import { SCHEMA_VERSION, SchemaTooNewError, checkVersion, stamp, versionOf } from "./schema.ts";

const dirs: string[] = [];
const world = () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-migrate-`);
	dirs.push(root);
	const conf = `${root}/conf`, state = `${root}/state`;
	mkdirSync(conf, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
	return { conf, state };
};
const put = (path: string, text: string) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Config files written by hand: none carries a schemaVersion. */
function oldInstall(w: { conf: string; state: string }) {
	put(`${w.conf}/servers.json`, JSON.stringify({ servers: [{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token" }] }));
	put(`${w.conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port: 3790 }));
	put(`${w.conf}/settings.json`, JSON.stringify({ principalName: "Ada" }));
	put(`${w.conf}/sweep.json`, JSON.stringify({ checks: [] }));
}

describe("schema helpers", () => {
	test("an unversioned record is version 0; a newer one is refused naming the file", () => {
		expect(versionOf("x", undefined)).toBe(0);
		expect(checkVersion("x", SCHEMA_VERSION)).toBe(SCHEMA_VERSION);
		expect(() => checkVersion("settings.json", SCHEMA_VERSION + 1)).toThrow(SchemaTooNewError);
		expect(() => checkVersion("settings.json", SCHEMA_VERSION + 1)).toThrow(/settings\.json has schemaVersion 3, but this Chamberlain understands up to 2/);
		for (const bad of ["1", -1, 1.5, null]) expect(() => versionOf("x", bad)).toThrow("schemaVersion must be a non-negative integer");
	});
	test("stamp puts the current version first and does not disturb the record", () => {
		expect(stamp({ a: 1 })).toEqual({ schemaVersion: SCHEMA_VERSION, a: 1 });
		expect(Object.keys(stamp({ a: 1 }))[0]).toBe("schemaVersion");
	});
});

describe("upgradeData: steps walk the chain", () => {
	const steps = { json: [(d: object) => ({ ...d, a: 1 }), (d: object) => ({ ...d, b: 2 }), (d: object) => ({ ...d, c: 3 })], jsonl: [], servers: [] } as unknown as typeof STEPS;
	test("from 0 runs every step, from 2 only the last, from the target none", () => {
		expect(upgradeData("json", {}, 0, 3, steps)).toEqual({ schemaVersion: 3, a: 1, b: 2, c: 3 });
		expect(upgradeData("json", { schemaVersion: 2 }, 2, 3, steps)).toEqual({ schemaVersion: 3, c: 3 });
		expect(upgradeData("json", { x: 1 }, 3, 3, steps)).toEqual({ x: 1 });
	});
	test("a missing step is an error, never a silent skip", () => expect(() => upgradeData("jsonl", {}, 0, 1, steps)).toThrow("no migration for jsonl from schemaVersion 0"));
	test("the shipped steps cover 0 to SCHEMA_VERSION for every kind", () => {
		for (const kind of Object.keys(STEPS) as (keyof typeof STEPS)[]) expect(STEPS[kind]).toHaveLength(SCHEMA_VERSION);
	});
	test("servers: an unversioned file is stamped, and each entry gains its adapter", () => {
		expect(upgradeData("servers", { servers: [{ name: "a" }] }, 0)).toEqual({ schemaVersion: 2, servers: [{ name: "a", adapter: "t3" }] });
	});
	test("servers 1 -> 2: every entry names its adapter, T3 unless it already names one, and nothing else changes", () => {
		const v1 = { schemaVersion: 1, servers: [{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token", mayBeOffline: true }, { name: "box", adapter: "other", socket: "/run/x.sock" }] };
		expect(upgradeData("servers", v1, 1)).toEqual({
			schemaVersion: 2,
			servers: [{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token", mayBeOffline: true, adapter: "t3" }, { name: "box", adapter: "other", socket: "/run/x.sock" }],
		});
		expect(upgradeData("servers", { schemaVersion: 2, servers: [{ name: "a", adapter: "t3" }] }, 2)).toEqual({ schemaVersion: 2, servers: [{ name: "a", adapter: "t3" }] });
	});
	test("every other kind only re-stamps at 1 -> 2", () => {
		expect(upgradeData("json", { schemaVersion: 1, host: "x" }, 1)).toEqual({ schemaVersion: 2, host: "x" });
		expect(upgradeData("jsonl", { schemaVersion: 1, type: "ask" }, 1)).toEqual({ schemaVersion: 2, type: "ask" });
	});
	test("a newer config file anywhere is refused, naming it", () => {
		const w = world();
		put(`${w.conf}/web.json`, JSON.stringify({ schemaVersion: 3, host: "127.0.0.1" }));
		expect(() => assertSupported(w)).toThrow("web.json has schemaVersion 3");
	});
	test("every versioned config file is on the list the migration walks", () => {
		expect(FILES.map((f) => f.name).sort()).toEqual(["servers.json", "settings.json", "sweep.json", "web.json"]);
	});
});

describe("assertSupported", () => {
	test("an empty install is fine", () => expect(assertSupported(world())).toEqual([]));
	test("an unversioned install reports its old records", () => {
		const w = world();
		oldInstall(w);
		expect(assertSupported(w).find((x) => x.what === "servers.json")).toMatchObject({ version: 0, old: 1 });
		expect(assertSupported(w).find((x) => x.what === "web.json")).toMatchObject({ version: 0, old: 1 });
	});
	test("a newer record in any versioned config file stops everything, and the message names the file", () => {
		for (const name of ["web.json", "settings.json", "sweep.json", "servers.json"]) {
			const w = world();
			put(`${w.conf}/${name}`, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }) + "\n");
			expect(() => assertSupported(w)).toThrow(new RegExp(`${name.replace(".", "\\.")} has schemaVersion ${SCHEMA_VERSION + 1}`));
		}
	});
});

describe("migrateStorage (config files)", () => {
	test("upgrades every unversioned file, keeps a backup, keeps mode 0600, and changes nothing else", () => {
		const w = world();
		oldInstall(w);
		const before = readFileSync(`${w.conf}/servers.json`, "utf8");
		const r = migrateStorage(w);
		expect(r.migrated.sort()).toEqual(["servers.json", "settings.json", "sweep.json", "web.json"]);
		expect(r.skipped).toEqual([]);
		expect(readFileSync(`${w.conf}/servers.json.pre-schema-v2.bak`, "utf8")).toBe(before);
		expect(readServers(w.conf)).toEqual([{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token", adapter: "t3" }]);
		expect(JSON.parse(readFileSync(`${w.conf}/servers.json`, "utf8")).schemaVersion).toBe(SCHEMA_VERSION);
		expect(JSON.parse(readFileSync(`${w.conf}/web.json`, "utf8"))).toEqual({ schemaVersion: SCHEMA_VERSION, host: "127.0.0.1", port: 3790 });
		for (const f of ["servers.json", "web.json", "settings.json"]) expect(statSync(`${w.conf}/${f}`).mode & 0o777).toBe(0o600);
		expect(existsSync(`${w.state}/.migrate.lock`)).toBe(false);
	});
	test("a version-1 install (stamped, but every server unnamed) gains `adapter: t3` on its servers and is re-stamped", () => {
		const w = world();
		const servers = { schemaVersion: 1, servers: [{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token" }, { name: "laptop", origin: "http://laptop:3773", tokenFile: "laptop-token", mayBeOffline: true, adapter: "t3" }] };
		put(`${w.conf}/servers.json`, JSON.stringify(servers));
		// Before the migration the old file already reads: every server is T3.
		expect(readServers(w.conf)!.map((x) => x.adapter)).toEqual(["t3", "t3"]);
		expect(assertSupported(w).find((x) => x.what === "servers.json")).toMatchObject({ version: 1, old: 1 });
		const r = migrateStorage(w);
		expect(r.migrated).toEqual(["servers.json"]);
		const out = JSON.parse(readFileSync(`${w.conf}/servers.json`, "utf8"));
		expect(out).toEqual({ schemaVersion: 2, servers: [{ ...servers.servers[0], adapter: "t3" }, servers.servers[1]] });
		expect(JSON.parse(readFileSync(`${w.conf}/servers.json.pre-schema-v2.bak`, "utf8"))).toEqual(servers);
		expect(migrateStorage(w)).toEqual({ migrated: [], skipped: [] });
	});
	test("is idempotent: a second run changes nothing and makes no new backup", () => {
		const w = world();
		oldInstall(w);
		migrateStorage(w);
		const snapshot = readFileSync(`${w.conf}/web.json`, "utf8");
		expect(migrateStorage(w)).toEqual({ migrated: [], skipped: [] });
		expect(readFileSync(`${w.conf}/web.json`, "utf8")).toBe(snapshot);
	});
	test("--check reports and changes nothing", () => {
		const w = world();
		oldInstall(w);
		const before = readFileSync(`${w.conf}/servers.json`, "utf8");
		const r = migrateStorage({ ...w, check: true });
		expect(r.migrated).toEqual([]);
		expect(r.skipped.length).toBeGreaterThan(0);
		expect(readFileSync(`${w.conf}/servers.json`, "utf8")).toBe(before);
		expect(existsSync(`${w.conf}/servers.json.pre-schema-v2.bak`)).toBe(false);
	});
	test("a file that is not 0600 is skipped with a reason, and the rest still migrate", () => {
		const w = world();
		oldInstall(w);
		chmodSync(`${w.conf}/web.json`, 0o644);
		const r = migrateStorage(w);
		expect(r.skipped).toEqual([{ what: "web.json", why: "not a private regular file (mode exactly 0600)" }]);
		expect(r.migrated).toContain("servers.json");
		expect(JSON.parse(readFileSync(`${w.conf}/web.json`, "utf8")).schemaVersion).toBeUndefined();
	});
	test("another process migrating at the same moment makes this one skip, not race (real processes: migrate-lock.test.ts)", () => {
		const w = world();
		oldInstall(w);
		const lock = holdFlock(w.conf, { waitMs: 0 });
		try {
			const r = migrateStorage({ ...w, lockWaitMs: 50 });
			expect(r.migrated).toEqual([]);
			expect(r.skipped.map((s) => s.what)).toEqual(["*"]);
			expect(r.skipped[0]!.why).toContain("another process is migrating");
		} finally { lock.release(); }
		expect(JSON.parse(readFileSync(`${w.conf}/web.json`, "utf8")).schemaVersion).toBeUndefined();
	});
	test("a newer file anywhere stops it before it touches anything", () => {
		const w = world();
		oldInstall(w);
		put(`${w.conf}/settings.json`, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
		expect(() => migrateStorage(w)).toThrow(SchemaTooNewError);
		expect(existsSync(`${w.conf}/servers.json.pre-schema-v2.bak`)).toBe(false);
	});
});

describe("entry points refuse a newer schema with exit code 3", () => {
	const run = async (script: string, w: { conf: string; state: string }, ...args: string[]) => {
		const p = Bun.spawn([process.execPath, new URL(script, import.meta.url).pathname, ...args], { env: { ...process.env, CHAMBERLAIN_CONF: w.conf, CHAMBERLAIN_STATE: w.state }, stdout: "pipe", stderr: "pipe" });
		const [err, code] = [await new Response(p.stderr).text(), await p.exited];
		return { err, code };
	};
	const TOOLS = [["./decided.ts", ["t", "d", "R1"]], ["./ruling.ts", ["list"]], ["./butler.ts", ["list"]], ["./afk.ts", ["held"]]] as const;
	test("migrate.ts, the command-line tools and the daemon, for a config file from a newer build", async () => {
		const w = world();
		put(`${w.conf}/settings.json`, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
		for (const [script, args] of [["./migrate.ts", []], ...TOOLS] as const) {
			const r = await run(script, w, ...args);
			expect([script, r.code]).toEqual([script, 3]);
			expect(r.err).toContain(`settings.json has schemaVersion ${SCHEMA_VERSION + 1}`);
		}
		const d = await run("../daemon.ts", w);
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
		const d = await run("../daemon.ts", w);
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

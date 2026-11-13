/**
 * File modes fail closed (audit finding M4). A secret or config file is a regular file with mode EXACTLY 0600 (0700, 0400 and the like are
 * refused: "no group or other bits" was the old, looser rule); the config and state directories are exactly 0700; and a database whose mode
 * cannot be made 0600 stops the process at start with a clear message, where a failed chmod used to be swallowed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readSettings, resetSettings } from "./config.ts";
import { migrateStorage } from "./migrate.ts";
import { assertPrivateDir, enforceMode, InsecureModeError, isPrivateFile, modeText, privateFile } from "./private.ts";
import { loadOperatingRules } from "./rules.ts";
import { readServers } from "./servers.ts";
import { openStore } from "./sqlite-store.ts";
import { readSweepConfig } from "./sweep.ts";
import { loadConfig } from "../web/config.ts";

const dirs: string[] = [];
afterEach(() => { resetSettings(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(`${tmpdir()}/chamberlain-modes-`); dirs.push(d); return d; };
const SRC = new URL("..", import.meta.url).pathname;

const LOOSE = [0o700, 0o500, 0o400, 0o200, 0o640, 0o644, 0o660, 0o666, 0o601, 0o610, 0o620, 0o604, 0o755] as const;

describe("a private file is a regular file with mode exactly 0600", () => {
	test("isPrivateFile: 0600 only", () => {
		const d = scratch();
		const f = `${d}/f`;
		writeFileSync(f, "x");
		chmodSync(f, 0o600);
		expect(isPrivateFile(statSync(f))).toBe(true);
		for (const mode of LOOSE) { chmodSync(f, mode); expect([modeText(mode), isPrivateFile(statSync(f))]).toEqual([modeText(mode), false]); }
		mkdirSync(`${d}/dir`, { mode: 0o600 });
		expect(isPrivateFile(statSync(`${d}/dir`))).toBe(false);
	});

	/** One config file per reader, each refused at every loose mode and accepted at 0600. */
	const READERS: [string, string, string, (conf: string) => unknown][] = [
		["privateFile (tokens, URLs, thread ids)", "read-token", "token", (c) => privateFile(c, "read-token")],
		["settings.json", "settings.json", "{}", (c) => readSettings(c)],
		["web.json", "web.json", JSON.stringify({ host: "127.0.0.1", port: 3790 }), (c) => loadConfig(c)],
		["servers.json", "servers.json", "[]", (c) => readServers(c)],
		["sweep.json", "sweep.json", JSON.stringify({ checks: [] }), (c) => readSweepConfig(c)],
		["operating-rules.md", "operating-rules.md", "rules", (c) => loadOperatingRules(c)],
	];
	for (const [name, file, body, read] of READERS) {
		test(`${name}: refused at every mode but 0600, with the mode it found`, () => {
			const conf = scratch();
			writeFileSync(`${conf}/${file}`, body);
			chmodSync(`${conf}/${file}`, 0o600);
			expect(() => read(conf)).not.toThrow();
			for (const mode of LOOSE) {
				resetSettings();
				chmodSync(`${conf}/${file}`, mode);
				expect(() => read(conf)).toThrow(new RegExp(`${modeText(mode)}|0600`));
			}
		});
	}

	test("the config migration skips a file that is not exactly 0600, naming why", () => {
		const root = scratch();
		const [conf, state] = [`${root}/conf`, `${root}/state`];
		mkdirSync(conf, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
		writeFileSync(`${conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port: 3790 }));
		chmodSync(`${conf}/web.json`, 0o700);
		const r = migrateStorage({ conf, state });
		expect(r.skipped).toContainEqual({ what: "web.json", why: "not a private regular file (mode exactly 0600)" });
	});

	test("no source file still tests a mode with the loose mask", () => {
		const loose: string[] = [];
		const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && /&\s*0o077/.test(readFileSync(p, "utf8"))) loose.push(p.slice(SRC.length)); } };
		walk(SRC);
		expect(loose).toEqual([]);
	});
});

describe("the database fails closed", () => {
	const failing = () => { throw Error("EPERM: operation not permitted"); };

	test("a new database is 0600 in a 0700 directory", () => {
		const root = scratch();
		const s = openStore(`${root}/state/chamberlain.db`);
		s.close();
		expect(modeText(statSync(`${root}/state/chamberlain.db`).mode)).toBe("0600");
		expect(modeText(statSync(`${root}/state`).mode)).toBe("0700");
	});

	test("a looser database or directory is made private, and the store opens", () => {
		const root = scratch();
		mkdirSync(`${root}/state`, { mode: 0o755 });
		chmodSync(`${root}/state`, 0o755);
		writeFileSync(`${root}/state/chamberlain.db`, "");
		chmodSync(`${root}/state/chamberlain.db`, 0o644);
		openStore(`${root}/state/chamberlain.db`).close();
		expect(modeText(statSync(`${root}/state/chamberlain.db`).mode)).toBe("0600");
		expect(modeText(statSync(`${root}/state`).mode)).toBe("0700");
	});

	test("a database that cannot be made 0600 stops the open with the mode, the wanted mode and how to fix it, and nothing is stored", () => {
		const root = scratch();
		mkdirSync(`${root}/state`, { mode: 0o700 });
		writeFileSync(`${root}/state/chamberlain.db`, "");
		chmodSync(`${root}/state/chamberlain.db`, 0o644);
		let err: unknown;
		try { openStore(`${root}/state/chamberlain.db`, { chmod: failing }); } catch (e) { err = e; }
		expect(err).toBeInstanceOf(InsecureModeError);
		const msg = (err as Error).message;
		for (const part of ["the database", `${root}/state/chamberlain.db`, "mode 0644", "not 0600", "EPERM", "Refusing to start", "chmod 600"]) expect(msg).toContain(part);
		// Not one table was created in it: it was refused before it was opened.
		expect(statSync(`${root}/state/chamberlain.db`).size).toBe(0);
		expect(existsSync(`${root}/state/chamberlain.db-wal`)).toBe(false);
	});

	test("a directory that cannot be made 0700 stops the open too, before a file is created in it", () => {
		const root = scratch();
		mkdirSync(`${root}/state`, { mode: 0o755 });
		chmodSync(`${root}/state`, 0o755);
		expect(() => openStore(`${root}/state/chamberlain.db`, { chmod: failing })).toThrow(/the state directory .* mode 0755, not 0700/);
		expect(existsSync(`${root}/state/chamberlain.db`)).toBe(false);
	});

	test("a chmod that fails does not matter when the mode is already right", () => {
		const root = scratch();
		openStore(`${root}/state/chamberlain.db`).close();
		openStore(`${root}/state/chamberlain.db`, { chmod: failing }).close();
	});

	test("enforceMode reads the mode back: a chmod that does nothing is caught", () => {
		const root = scratch();
		const f = `${root}/f`;
		writeFileSync(f, "");
		chmodSync(f, 0o644);
		expect(() => enforceMode(f, 0o600, "the file", () => {})).toThrow(InsecureModeError);
		expect(() => enforceMode(f, 0o600, "the file")).not.toThrow();
	});
});

describe("directories are exactly 0700", () => {
	test("assertPrivateDir: refuses an existing directory at any other mode, is quiet for a missing one, and refuses a file", () => {
		const root = scratch();
		for (const mode of [0o755, 0o750, 0o770, 0o500, 0o777]) { mkdirSync(`${root}/d${mode}`); chmodSync(`${root}/d${mode}`, mode); expect(() => assertPrivateDir(`${root}/d${mode}`, "the config directory")).toThrow(InsecureModeError); }
		mkdirSync(`${root}/ok`, { mode: 0o700 });
		expect(() => assertPrivateDir(`${root}/ok`, "the config directory")).not.toThrow();
		expect(() => assertPrivateDir(`${root}/missing`, "the config directory")).not.toThrow();
		writeFileSync(`${root}/file`, "");
		expect(() => assertPrivateDir(`${root}/file`, "the config directory")).toThrow("not a directory");
	});
});

describe("an entry point stops at start, with a clear message and no stack trace", () => {
	test("the daemon, with a config directory that is not 0700, exits 4 before it reads a file in it", async () => {
		const root = scratch();
		const [conf, state] = [`${root}/conf`, `${root}/state`];
		mkdirSync(conf); chmodSync(conf, 0o755);
		mkdirSync(state, { mode: 0o700 });
		const p = Bun.spawn([process.execPath, `${SRC}daemon.ts`], { env: { ...process.env, HOME: root, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state, CHAMBERLAIN_T3_STATE_DB: `${root}/none.sqlite`, CHAMBERLAIN_DRY: "1" }, stdout: "ignore", stderr: "pipe" });
		const err = await new Response(p.stderr).text();
		expect(await p.exited).toBe(4);
		for (const part of ["chamberlain:", "the config directory", conf, "mode 0755", "not 0700", "chmod 700"]) expect(err).toContain(part);
		expect(err).not.toContain("    at ");
	}, 30_000);

	test("an entry point whose database cannot be made private exits 4 with the reason", async () => {
		const root = scratch();
		const state = `${root}/state`;
		mkdirSync(state, { mode: 0o700 });
		writeFileSync(`${state}/chamberlain.db`, "");
		chmodSync(`${state}/chamberlain.db`, 0o644);
		const p = Bun.spawn([process.execPath, `${SRC}testing/mode-probe.ts`, state], { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" });
		const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
		expect(await p.exited).toBe(4);
		expect(out).not.toContain("opened");
		for (const part of ["chamberlain:", "the database", "mode 0644", "not 0600", "chmod 600"]) expect(err).toContain(part);
		expect(err).not.toContain("    at ");
	}, 30_000);
});


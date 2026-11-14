/** The page's entry point refuses to start, and exits with the code a supervisor reads, before it binds or touches a database. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const SERVER = new URL("./server.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch home with a config directory holding the given `web` section, and the page started with `args` over it. */
function start(
	args: string[],
	env: (home: string, conf: string, state: string) => Record<string, string | undefined>,
	web?: object,
) {
	const home = mkdtempSync(`${tmpdir()}/chamberlain-server-main-`);
	dirs.push(home);
	const conf = `${home}/conf`;
	const state = `${home}/state`;
	mkdirSync(conf, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	if (web) writeFileSync(`${conf}/config.json`, JSON.stringify({ schemaVersion: 1, web }), { mode: 0o600 });
	const r = Bun.spawnSync([process.execPath, SERVER, ...args], {
		env: { ...process.env, HOME: home, ...env(home, conf, state) },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), home };
}

describe("the page refuses to start", () => {
	test("--test without both CHAMBERLAIN_CONF and CHAMBERLAIN_STATE exits 2 and says what it needs", () => {
		for (const missing of ["CHAMBERLAIN_CONF", "CHAMBERLAIN_STATE"]) {
			const r = start(["--test"], (_h, conf, state) => ({
				CHAMBERLAIN_CONF: missing === "CHAMBERLAIN_CONF" ? undefined : conf,
				CHAMBERLAIN_STATE: missing === "CHAMBERLAIN_STATE" ? undefined : state,
			}));
			expect([missing, r.code]).toEqual([missing, 2]);
			expect(r.err).toContain("--test needs CHAMBERLAIN_CONF and CHAMBERLAIN_STATE pointed at scratch directories");
		}
	});
	test("--test pointed at the live config or state directory exits 2 too", () => {
		const live = start(["--test"], (home, _c, state) => ({
			CHAMBERLAIN_CONF: `${home}/.config/chamberlain`,
			CHAMBERLAIN_STATE: state,
			XDG_CONFIG_HOME: undefined,
		}));
		expect(live.code).toBe(2);
		expect(live.err).toContain("--test needs CHAMBERLAIN_CONF");
		const liveState = start(["--test"], (home, conf) => ({
			CHAMBERLAIN_CONF: conf,
			CHAMBERLAIN_STATE: `${home}/.local/state/chamberlain`,
			XDG_STATE_HOME: undefined,
		}));
		expect(liveState.code).toBe(2);
		expect(liveState.err).toContain("--test needs CHAMBERLAIN_CONF");
	});
	test("a config with no web section exits 2 with the reason, for the page and for the link command alike", () => {
		for (const args of [[], ["--test"], ["link"], ["rotate-token"]]) {
			const r = start(args, (_h, conf, state) => ({ CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state }));
			expect([args, r.code]).toEqual([args, 2]);
			expect(r.err).toContain('no "web" section in');
		}
	});
	test("--test binds to loopback only: any other address exits 2", () => {
		const r = start(["--test"], (_h, conf, state) => ({ CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state }), {
			host: "100.64.0.1",
			port: 3790,
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain("--test binds to loopback only");
	});
});

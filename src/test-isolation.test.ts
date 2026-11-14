/**
 * The test run is sealed off from the machine it runs on (src/test-setup.ts). These tests hold that: a developer's own settings, tokens
 * and alert command are out of reach, and the alert command in force is a recorder. The run's last step (also in test-setup.ts) fails it
 * if anything called that recorder, so a test that would reach a real alert command fails the suite instead of paging someone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { alertCommand, CONF, readSettings, STATE } from "./core/config.ts";

const root = process.env.TMPDIR!;
const marker = process.env.CHAMBERLAIN_TEST_ALERT_MARKER!;

describe("a test run touches nothing of the developer's", () => {
	test("home, config and state are scratch directories under this run's root", () => {
		expect(tmpdir()).toBe(root);
		expect(process.env.HOME).toBe(`${root}/home`);
		expect(CONF).toBe(`${root}/conf`);
		expect(STATE).toBe(`${root}/state`);
		for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) expect(process.env[v]!.startsWith(`${root}/home/`)).toBe(true);
	});
	test("no settings are read: the config directory is empty, so there is no principal name, T3 path or alert command of the developer's", () => {
		expect(readSettings()).toEqual({});
	});
	test("the home directory's bin is not on the PATH, and the scratch home has no bin of its own", () => {
		expect((process.env.PATH ?? "").split(":")).not.toContain(`${process.env.HOME}/bin`);
		expect(existsSync(`${process.env.HOME}/bin`)).toBe(false);
	});
});

describe("the alert command is a recorder, and a call to it fails the run", () => {
	test("the command in force is the sentinel in this run's root", () => {
		expect(alertCommand()).toBe(`${root}/alert-sentinel.sh`);
	});
	test("the sentinel runs nothing but records its arguments (and is the only thing the run's final check reads)", () => {
		expect(existsSync(marker)).toBe(false);
		const p = Bun.spawnSync([alertCommand()!, "warning", "a title", "a summary"]);
		expect(p.exitCode).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("warning a title a summary\n");
		// This test made the call on purpose; take the record back so the run's final check passes.
		rmSync(marker);
	});
});

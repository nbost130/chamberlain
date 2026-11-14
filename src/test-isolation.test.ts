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
		for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"])
			expect(process.env[v]!.startsWith(`${root}/home/`)).toBe(true);
	});
	test("no settings are read: the config directory is empty, so there is no principal name, T3 path or alert command of the developer's", () => {
		expect(readSettings()).toEqual({});
	});
	test("the home directory's bin is not on the PATH, and the scratch home has no bin of its own", () => {
		expect((process.env.PATH ?? "").split(":")).not.toContain(`${process.env.HOME}/bin`);
		expect(existsSync(`${process.env.HOME}/bin`)).toBe(false);
	});
});

describe("git is not pointed at the developer's repository", () => {
	test("git repository variables are not in the environment", () => {
		expect(
			Object.keys(process.env).filter((k) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR)$/.test(k)),
		).toEqual([]);
	});
	test("a hook's GIT_DIR is dropped before any test runs (a pre-push hook sets it, and a test's git init would write into the pushed repository)", async () => {
		const here = new URL("./test-isolation.test.ts", import.meta.url).pathname;
		const p = Bun.spawn(["bun", "test", here, "-t", "git repository variables are not in the environment"], {
			env: {
				...process.env,
				GIT_DIR: "/nonexistent/.git",
				GIT_WORK_TREE: "/nonexistent",
				GIT_INDEX_FILE: "/nonexistent/index",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		expect({ code, ran: /\b1 pass\b/.test(out + err) }).toEqual({ code: 0, ran: true });
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

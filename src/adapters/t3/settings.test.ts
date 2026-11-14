import { afterEach, expect, test } from "bun:test";
import { resetSettings } from "../../core/config.ts";
import { t3BaseDir, t3StateDbPath } from "./settings.ts";

const KEYS = ["CHAMBERLAIN_T3_DIR", "CHAMBERLAIN_T3_STATE_DB"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	resetSettings();
});

test("defaults to ~/.t3 and the statev2 database under it", () => {
	delete process.env.CHAMBERLAIN_T3_DIR;
	delete process.env.CHAMBERLAIN_T3_STATE_DB;
	expect(t3BaseDir()).toBe(`${process.env.HOME}/.t3`);
	expect(t3StateDbPath()).toBe(`${process.env.HOME}/.t3/userdata/statev2.sqlite`);
});
test("CHAMBERLAIN_T3_DIR moves both, and CHAMBERLAIN_T3_STATE_DB names the database alone", () => {
	delete process.env.CHAMBERLAIN_T3_STATE_DB;
	process.env.CHAMBERLAIN_T3_DIR = "/srv/t3";
	expect(t3BaseDir()).toBe("/srv/t3");
	expect(t3StateDbPath()).toBe("/srv/t3/userdata/statev2.sqlite");
	process.env.CHAMBERLAIN_T3_STATE_DB = "/data/state.sqlite";
	expect(t3StateDbPath()).toBe("/data/state.sqlite");
});
test("a leading ~ is expanded", () => {
	delete process.env.CHAMBERLAIN_T3_STATE_DB;
	process.env.CHAMBERLAIN_T3_DIR = "~/custom-t3";
	expect(t3BaseDir()).toBe(`${process.env.HOME}/custom-t3`);
});

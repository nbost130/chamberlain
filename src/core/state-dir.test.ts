import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultStore } from "./default-store.ts";
import { configDir, stateDir } from "./state-dir.ts";
import { DB_FILE } from "./store.ts";

const scratch = () => mkdtempSync(`${tmpdir()}/chamberlain-state-`);
const HOME = "/home/u";

describe("where the directories are (XDG Base Directory Specification)", () => {
	test("state: CHAMBERLAIN_STATE, then XDG_STATE_HOME, then ~/.local/state", () => {
		expect(stateDir({}, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg" }, HOME)).toBe("/var/xdg/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg/" }, HOME)).toBe("/var/xdg/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg", CHAMBERLAIN_STATE: "/srv/chamberlain-state" }, HOME)).toBe("/srv/chamberlain-state");
	});
	test("an empty or relative value is invalid and ignored, as the specification says", () => {
		expect(stateDir({ XDG_STATE_HOME: "" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "relative/dir" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ CHAMBERLAIN_STATE: "relative" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ CHAMBERLAIN_STATE: "" }, HOME)).toBe("/home/u/.local/state/chamberlain");
	});
	test("config follows the same rule", () => {
		expect(configDir({}, HOME)).toBe("/home/u/.config/chamberlain");
		expect(configDir({ XDG_CONFIG_HOME: "/etc/xdg" }, HOME)).toBe("/etc/xdg/chamberlain");
		expect(configDir({ CHAMBERLAIN_CONF: "/x" }, HOME)).toBe("/x");
	});
});

describe("defaultStore", () => {
	test("opens the database in the state directory it is given, and makes the directory", () => {
		const root = scratch();
		const s = defaultStore(`${root}/fresh`);
		expect(s.path).toBe(`${root}/fresh/${DB_FILE}`);
		s.close();
	});
});

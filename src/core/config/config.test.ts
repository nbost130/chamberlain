import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	DEFAULT_PRINCIPAL,
	Principal,
	parseSettings,
	principal,
	principalPoss,
	readSettings,
	resetSettings,
} from "./config.ts";

const KEYS = ["CHAMBERLAIN_PRINCIPAL", "CHAMBERLAIN_T3_DIR", "CHAMBERLAIN_T3_STATE_DB", "CHAMBERLAIN_CONF"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	resetSettings();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const confWith = (settings: object, mode = 0o600) => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-conf-`);
	dirs.push(d);
	writeFileSync(`${d}/settings.json`, JSON.stringify(settings));
	chmodSync(`${d}/settings.json`, mode);
	return d;
};

describe("parseSettings", () => {
	test("keeps the known keys, stamps the version, and trims", () => {
		expect(parseSettings({ principalName: " Ada ", t3BaseDir: "~/.t3", compactTokens: 300000, unknown: 1 })).toEqual({
			schemaVersion: 2,
			principalName: "Ada",
			t3BaseDir: "~/.t3",
			compactTokens: 300000,
		});
	});
	test("refuses a malformed or newer file", () => {
		expect(() => parseSettings([])).toThrow("expected a JSON object");
		expect(() => parseSettings({ principalName: "" })).toThrow("non-empty string");
		expect(() => parseSettings({ compactTokens: -5 })).toThrow("positive number");
		expect(() => parseSettings({ schemaVersion: 3 })).toThrow("newer Chamberlain");
	});
});

describe("principal name", () => {
	test("defaults to a neutral 'the operator'", () => {
		delete process.env.CHAMBERLAIN_PRINCIPAL;
		expect(principal()).toBe(DEFAULT_PRINCIPAL);
		expect(Principal()).toBe("The operator");
		expect(principalPoss()).toBe("the operator's");
	});
	test("settings.json sets it, and the environment overrides settings.json", () => {
		delete process.env.CHAMBERLAIN_PRINCIPAL;
		process.env.CHAMBERLAIN_CONF = confWith({ principalName: "Ada" });
		// config.ts reads CONF at import, so ask for the file directly:
		expect(readSettings(process.env.CHAMBERLAIN_CONF).principalName).toBe("Ada");
		process.env.CHAMBERLAIN_PRINCIPAL = "Grace";
		expect(principal()).toBe("Grace");
		expect(Principal()).toBe("Grace");
	});
});

describe("settings file", () => {
	test("a world-readable settings.json is refused", () => {
		const d = confWith({ principalName: "Ada" }, 0o644);
		expect(() => readSettings(d)).toThrow("0600");
	});
	test("no file is no settings", () => expect(readSettings(mkdtempSync(`${tmpdir()}/chamberlain-none-`))).toEqual({}));
});

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { configValue, setting, settingSource } from "./layout.ts";
import { legacyValue } from "./layout-legacy.ts";
import { ConfigFileError, parseConfigDoc, SCALARS, SECTIONS } from "./layout-schema.ts";
import { SchemaTooNewError } from "./schema.ts";

const refused = (doc: unknown, message: string) =>
	expect(() => parseConfigDoc(doc)).toThrow(new ConfigFileError(message));

describe("parseConfigDoc", () => {
	test("accepts a document of known keys, null for any of them, and the bookkeeping keys", () => {
		const doc = {
			schemaVersion: 1,
			principal: "Pat",
			recover: null,
			exclude: ["a"],
			stallMs: 0,
			maxAttempts: 3,
			compactTokens: 10,
			servers: [],
			web: {},
			sweep: null,
			settledMatch: { titleOverlap: true },
			threads: { steward: "t1", decisions: null },
			migrated: { files: [] },
		};
		expect(parseConfigDoc(doc)).toBe(doc);
		expect(parseConfigDoc({})).toEqual({});
	});

	test("refuses what is not an object, and a bad or newer schema version", () => {
		for (const raw of [null, [], "x", 3]) refused(raw, "config.json: expected a JSON object");
		refused({ schemaVersion: "1" }, 'config.json: schemaVersion must be a non-negative integer, got "1"');
		refused({ schemaVersion: 1.5 }, "config.json: schemaVersion must be a non-negative integer, got 1.5");
		refused({ schemaVersion: -1 }, "config.json: schemaVersion must be a non-negative integer, got -1");
		expect(() => parseConfigDoc({ schemaVersion: 2 })).toThrow(SchemaTooNewError);
	});

	test("refuses a scalar of the wrong kind, naming the key", () => {
		const bad = (k: string, v: unknown, what: string) => refused({ [k]: v }, `config.json: "${k}" must be ${what}`);
		for (const v of ["", "  ", 5]) bad("principal", v, "a non-empty string");
		for (const v of ["yes", 1]) bad("recover", v, "true or false");
		for (const v of ["a", ["a", 1], ["a", " "], ["a", ""]]) bad("exclude", v, "a list of non-empty strings");
		for (const v of [0, -1, "5"]) bad("compactTokens", v, "a positive number");
		for (const v of [-1, "5"]) bad("stallMs", v, "a number, 0 or more");
		for (const v of [0, 1.5, "2"]) bad("maxAttempts", v, "a whole number, 1 or more");
	});

	test("refuses a section of the wrong shape: a list for servers, an object for the rest", () => {
		refused({ servers: {} }, 'config.json: "servers" must be a list');
		refused({ servers: "x" }, 'config.json: "servers" must be a list');
		for (const v of [[], "x", 3]) refused({ web: v }, 'config.json: "web" must be an object');
		refused({ threads: [] }, 'config.json: "threads" must be an object');
	});

	test("refuses a settledMatch that does not parse, as a config file error", () => {
		refused(
			{ settledMatch: { titleOverlap: "yes" } },
			'config.json: "settledMatch.titleOverlap" must be true or false',
		);
		refused({ settledMatch: { nope: 1 } }, 'config.json: "settledMatch" has unknown keys: nope');
	});

	test("refuses a key this build does not know, listing the ones it does", () => {
		refused(
			{ bogus: 1 },
			`config.json: unknown key "bogus" (keys: ${[...Object.keys(SCALARS), ...SECTIONS].join(", ")})`,
		);
	});

	test("refuses a bad thread entry, and reports the first problem in key order", () => {
		refused({ threads: { x: "t" } }, 'config.json: "threads" has an unknown key "x" (keys: steward, decisions, desk)');
		for (const v of ["", " ", 5])
			refused({ threads: { desk: v } }, 'config.json: "threads.desk" must be a non-empty thread id');
		refused({ stallMs: -1, principal: "" }, 'config.json: "stallMs" must be a number, 0 or more');
		refused({ principal: "", stallMs: -1 }, 'config.json: "principal" must be a non-empty string');
	});
});

describe("a scalar from the environment", () => {
	const conf = () => mkdtempSync(`${tmpdir()}/layout-env-`);
	const get = (key: keyof typeof SCALARS, raw: string | undefined, c = conf()): unknown =>
		setting(
			key,
			c,
			raw === undefined ? {} : { [`CHAMBERLAIN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`]: raw },
		);

	test("a string comes back as it is, even empty", () => {
		expect(get("principal", "Pat Q")).toBe("Pat Q");
		expect(get("principal", "")).toBe("");
		expect(get("principal", undefined)).toBeUndefined();
	});
	test("a boolean is 1 or 0 and nothing else", () => {
		expect(get("recover", "1")).toBe(true);
		expect(get("recover", "0")).toBe(false);
		for (const raw of ["true", "yes", "2", ""]) expect(get("recover", raw)).toBeUndefined();
	});
	test("a list is split on commas, trimmed, and drops the empty ones", () => {
		expect(get("exclude", " a, b,,c ,")).toEqual(["a", "b", "c"]);
		expect(get("exclude", "")).toEqual([]);
	});
	test("a number must be finite, and fit its kind", () => {
		expect(get("compactTokens", "5")).toBe(5);
		expect(get("compactTokens", " 2.5 ")).toBe(2.5);
		for (const raw of ["0", "-1", "", "  ", "abc", "Infinity"]) expect(get("compactTokens", raw)).toBeUndefined();
		expect(get("stallMs", "0")).toBe(0);
		for (const raw of ["-1", "x", " "]) expect(get("stallMs", raw)).toBeUndefined();
		expect(get("maxAttempts", "3")).toBe(3);
		for (const raw of ["0", "2.5", "-2", "x"]) expect(get("maxAttempts", raw)).toBeUndefined();
	});
	test("an unusable value falls through to config.json, and the source says which won", () => {
		const c = conf();
		writeFileSync(`${c}/config.json`, JSON.stringify({ stallMs: 7 }), { mode: 0o600 });
		expect(setting("stallMs", c, { CHAMBERLAIN_STALL_MS: "oops" })).toBe(7);
		expect(setting("stallMs", c, { CHAMBERLAIN_STALL_MS: "9" })).toBe(9);
		expect(settingSource("stallMs", c, { CHAMBERLAIN_STALL_MS: "9" })).toBe("env CHAMBERLAIN_STALL_MS");
		expect(settingSource("stallMs", c, { CHAMBERLAIN_STALL_MS: "oops" })).toBe("config.json");
		expect(settingSource("maxAttempts", c, {})).toBe("default");
	});
});

describe("the legacy files", () => {
	const conf = (files: Record<string, unknown> = {}, mode = 0o600) => {
		const c = mkdtempSync(`${tmpdir()}/layout-legacy-`);
		mkdirSync(`${c}/secrets`, { mode: 0o700 });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(`${c}/${name}`, JSON.stringify(body));
			chmodSync(`${c}/${name}`, mode);
		}
		return c;
	};

	test("a settings.json key comes from settings.json under its config name; a key it lacks is undefined", () => {
		const c = conf({ "settings.json": { principalName: "Pat", t3BaseDir: "/t3" } });
		expect(legacyValue(c, "principal")).toEqual({ value: "Pat", file: "settings.json" });
		expect(legacyValue(c, "t3Dir")).toEqual({ value: "/t3", file: "settings.json" });
		expect(legacyValue(c, "alertCmd")).toBeUndefined();
		expect(legacyValue(conf(), "principal")).toBeUndefined();
	});
	test("an unknown key, or a section whose file is absent, is undefined", () => {
		expect(legacyValue(conf(), "bogus")).toBeUndefined();
		expect(legacyValue(conf(), "web")).toBeUndefined();
	});
	test("servers.json gives its list, and refuses a file without one or from a newer schema", () => {
		const entry = { name: "main", adapter: "t3" };
		expect(legacyValue(conf({ "servers.json": { schemaVersion: 2, servers: [entry] } }), "servers")).toEqual({
			value: [entry],
			file: "servers.json",
		});
		expect(() => legacyValue(conf({ "servers.json": { schemaVersion: 2 } }), "servers")).toThrow(
			'servers.json: need {"schemaVersion": 2, "servers": [{name, adapter, ...}]}',
		);
		expect(() => legacyValue(conf({ "servers.json": [] }), "servers")).toThrow("need");
		expect(() => legacyValue(conf({ "servers.json": { schemaVersion: 99, servers: [] } }), "servers")).toThrow(
			SchemaTooNewError,
		);
	});
	test("web.json, sweep.json and operating-rules.json give their body without the version", () => {
		const c = conf({
			"web.json": { schemaVersion: 2, port: 1 },
			"sweep.json": [1],
			"operating-rules.json": { schemaVersion: 2, r: 1 },
		});
		expect(legacyValue(c, "web")).toEqual({ value: { port: 1 }, file: "web.json" });
		expect(legacyValue(c, "sweep")).toEqual({ value: [1], file: "sweep.json" });
		expect(legacyValue(c, "operatingRules")).toEqual({ value: { r: 1 }, file: "operating-rules.json" });
		expect(() => legacyValue(conf({ "web.json": { schemaVersion: 99 } }), "web")).toThrow(SchemaTooNewError);
	});
	test("alert-desk.json and judge.json are read whole, with a trust note when others can write them", () => {
		const safe = conf({ "alert-desk.json": { a: 1 }, "judge.json": { schemaVersion: 2, j: 1 } }, 0o644);
		expect(legacyValue(safe, "alertDesk")).toEqual({ value: { a: 1 }, file: "alert-desk.json" });
		expect(legacyValue(safe, "judge")).toEqual({ value: { schemaVersion: 2, j: 1 }, file: "judge.json" });
		const open = legacyValue(conf({ "alert-desk.json": { a: 1 } }, 0o666), "alertDesk");
		expect(open?.value).toEqual({ a: 1 });
		expect(open?.trust).toContain("world-writable");
	});
	test("a private legacy file that others can read is refused with its mode", () => {
		const c = conf({ "web.json": {} }, 0o644);
		expect(() => legacyValue(c, "web")).toThrow(
			`${c}/web.json must be a private regular file with mode exactly 0600 (it is 0644): chmod 600 it first.`,
		);
	});
	test("configValue reads config.json first, and null there means none", () => {
		const c = conf({ "settings.json": { principalName: "Old" } });
		expect(configValue(c, "principal")).toEqual({ value: "Old", file: "settings.json" });
		writeFileSync(`${c}/config.json`, JSON.stringify({ principal: "New" }), { mode: 0o600 });
		expect(configValue(c, "principal")).toEqual({ value: "New", file: "config.json" });
		writeFileSync(`${c}/config.json`, JSON.stringify({ principal: null }), { mode: 0o600 });
		expect(configValue(c, "principal")).toBeUndefined();
	});
});

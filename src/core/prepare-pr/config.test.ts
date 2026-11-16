import { describe, expect, test } from "bun:test";
import { PREPARE_PR_DEFAULTS, parsePreparePr } from "./config.ts";

describe("parsePreparePr", () => {
	test("defaults when omitted", () => {
		expect(parsePreparePr(undefined)).toMatchObject({
			enabled: false,
			intervalMinutes: 1,
			oneWayMode: "shadow",
			otherMode: "shadow",
		});
		expect(parsePreparePr(undefined).repos).toEqual([...PREPARE_PR_DEFAULTS.repos]);
	});
	test("independent oneWayMode and otherMode", () => {
		const c = parsePreparePr({ enabled: true, oneWayMode: "live", otherMode: "shadow" });
		expect(c.oneWayMode).toBe("live");
		expect(c.otherMode).toBe("shadow");
	});
	test("refuses unknown keys and bad modes", () => {
		expect(() => parsePreparePr({ loud: true })).toThrow("unknown key");
		expect(() => parsePreparePr({ oneWayMode: "loud" })).toThrow("oneWayMode");
		expect(() => parsePreparePr({ intervalMinutes: 0 })).toThrow("intervalMinutes");
	});
});

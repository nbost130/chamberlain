/** config, continued: see config.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { MAIL_DEFAULTS } from "./defaults.ts";
import { daysOf, parseSchedule } from "./schedule.ts";

describe("mail.schedule", () => {
	const D = MAIL_DEFAULTS.schedule;
	test("days are daily, a range or a list, Monday first", () => {
		expect(daysOf("daily")).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(daysOf("mon-fri")).toEqual([0, 1, 2, 3, 4]);
		expect(daysOf("mon,wed,sat-sun")).toEqual([0, 2, 5, 6]);
		for (const bad of ["", "weekdays", "fri-mon", "mon-tue-wed", "mon,", "Mon"])
			expect(daysOf(bad), bad).toBeUndefined();
	});
	test("times are 24 hour HH:MM and may be empty (only the Steward runs it)", () => {
		expect(parseSchedule({ times: ["16:30", "07:30"] }, "s", D).times).toEqual(["07:30", "16:30"]);
		expect(parseSchedule({ times: [] }, "s", D).times).toEqual([]);
		expect(() => parseSchedule({ times: ["07:30", "07:30"] }, "s", D)).toThrow("each time must be different");
		for (const times of [["7:30"], ["24:00"], ["07:60"], "07:30", [730]])
			expect(() => parseSchedule({ times }, "s", D), JSON.stringify(times)).toThrow("times must be");
	});
	test("a time zone is local or a real IANA name", () => {
		expect(parseSchedule({ tz: "Europe/London" }, "s", D).tz).toBe("Europe/London");
		expect(parseSchedule({ tz: "local" }, "s", D).tz).toBe("local");
		expect(() => parseSchedule({ tz: "Mars/Olympus" }, "s", D)).toThrow("IANA time zone");
		expect(() => parseSchedule({ days: "weekdays" }, "s", D)).toThrow("days must be");
		expect(() => parseSchedule({ maxRunsPerDay: 0 }, "s", D)).toThrow("maxRunsPerDay must be a positive whole number");
		expect(() => parseSchedule({ every: "3h" }, "s", D)).toThrow('unknown key "every"');
	});
});

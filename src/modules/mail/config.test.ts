import { describe, expect, test } from "bun:test";
import { MAIL_DEFAULTS, mailEnabled, parseMail, UNATTENDED_FLOORS } from "./config.ts";
import { parseRoutes } from "./routes.ts";
import { daysOf, parseSchedule } from "./schedule.ts";

/** The design's example (docs/EMAIL-TRIAGE.md section 2), as written there. */
const EXAMPLE = {
	provider: "gog",
	mode: "shadow",
	allowMailToLeaveMachine: true,
	gog: { command: "gog", account: "me@example.com", timeoutMs: 60000 },
	scope: { query: "in:inbox", lookbackDays: 7, maxMessagesPerRun: 200 },
	schedule: { times: ["07:30", "16:30"], days: "mon-fri", tz: "America/New_York", maxRunsPerDay: 4 },
	labels: { prefix: "Chamberlain" },
	models: { command: "claude", driver: "haiku", escalate: "sonnet", top: "opus" },
	budget: {
		driverCallsPerRun: 10,
		escalateCallsPerRun: 8,
		newsletterCallsPerRun: 3,
		topCallsPerRun: 0,
		inputTokensPerDay: 600000,
	},
	important: { senders: ["@school.example"], words: ["invoice", "due", "contract", "tax", "court", "overdue"] },
	newsletters: [{ name: "Unsupervised Learning", match: { listId: "<the newsletter's List-Id>" }, maxHighlights: 5 }],
	interests: ["AI security", "agents", "personal knowledge tools"],
	routes: [
		{ id: "steward", label: "Task for the Steward", kind: "steward" },
		{ id: "reader", label: "Readwise Reader", kind: "command", command: ["/path/to/save-to-reader"] },
		{ id: "obsidian", label: "Obsidian Reading list", kind: "file", file: "~/notes/Reading list.md" },
	],
	defaultRoute: "obsidian",
	cleanup: {
		unattended: { minApproval: 0.95, shadowDays: 14, minBatches: 10, sampleRate: 0.25, sampleWindow: 8 },
	},
};

describe("mail: off by default", () => {
	test("absent, empty, or provider none is off; Chamberlain behaves as it does without the module", () => {
		expect(parseMail(undefined)).toEqual(MAIL_DEFAULTS);
		expect(parseMail({})).toEqual(MAIL_DEFAULTS);
		expect(parseMail({ provider: "none" })).toEqual(MAIL_DEFAULTS);
		expect(MAIL_DEFAULTS).toMatchObject({ provider: "none", mode: "shadow", allowMailToLeaveMachine: false });
		for (const off of [undefined, {}, { provider: "none" }, { provider: "none", allowMailToLeaveMachine: true }])
			expect(mailEnabled(off)).toBe(false);
		expect(mailEnabled({ provider: "gog", allowMailToLeaveMachine: true })).toBe(true);
	});

	test("the defaults are a copy: changing one parse does not change the next", () => {
		const a = parseMail(undefined);
		a.important.words.push("x");
		a.routes.pop();
		expect(parseMail(undefined)).toEqual(MAIL_DEFAULTS);
	});

	test("the unattended-archive mode has no switch in config: every default and every key leaves it to the measured trial", () => {
		expect(Object.keys(MAIL_DEFAULTS.cleanup.unattended)).toEqual([
			"minApproval",
			"shadowDays",
			"minBatches",
			"sampleRate",
			"sampleWindow",
		]);
		for (const key of ["enabled", "on", "mode", "allow"])
			expect(() => parseMail({ cleanup: { unattended: { [key]: true } } })).toThrow(`unknown key "${key}"`);
		expect(() => parseMail({ cleanup: { unattended: true } })).toThrow("expected an object");
		expect(() => parseMail({ cleanup: { mode: "unattended" } })).toThrow('unknown key "mode"');
	});

	test("the schedule is weekdays 07:30 and 16:30 (the operator's answer to design question 1)", () => {
		expect(MAIL_DEFAULTS.schedule).toEqual({
			times: ["07:30", "16:30"],
			days: "mon-fri",
			tz: "local",
			maxRunsPerDay: 4,
		});
	});

	test("the defaults a person reads in the design, key for key", () => {
		expect(MAIL_DEFAULTS).toEqual({
			provider: "none",
			mode: "shadow",
			allowMailToLeaveMachine: false,
			gog: { command: "gog", account: null, timeoutMs: 60000, env: [] },
			command: { argv: null, timeoutMs: 60000 },
			scope: { query: "in:inbox", lookbackDays: 7, maxMessagesPerRun: 200 },
			schedule: { times: ["07:30", "16:30"], days: "mon-fri", tz: "local", maxRunsPerDay: 4 },
			labels: { prefix: "Chamberlain" },
			models: { command: "claude", driver: "haiku", escalate: "sonnet", top: "opus" },
			budget: {
				driverCallsPerRun: 10,
				escalateCallsPerRun: 8,
				newsletterCallsPerRun: 3,
				topCallsPerRun: 0,
				inputTokensPerDay: 600000,
			},
			important: { senders: [], words: ["invoice", "due", "contract", "tax", "court", "overdue"] },
			newsletters: [],
			interests: [],
			routes: [{ id: "steward", label: "Task for the Steward", kind: "steward" }],
			defaultRoute: "steward",
			cleanup: { unattended: { minApproval: 0.95, shadowDays: 14, minBatches: 10, sampleRate: 0.25, sampleWindow: 8 } },
		});
	});
});

describe("mail: the design's example", () => {
	test("parses as written: every key is accepted and nothing is changed", () => {
		const c = parseMail(EXAMPLE);
		expect(c).toEqual({
			...MAIL_DEFAULTS,
			provider: "gog",
			allowMailToLeaveMachine: true,
			gog: { command: "gog", account: "me@example.com", timeoutMs: 60000, env: [] },
			schedule: { times: ["07:30", "16:30"], days: "mon-fri", tz: "America/New_York", maxRunsPerDay: 4 },
			important: { senders: ["@school.example"], words: EXAMPLE.important.words },
			newsletters: EXAMPLE.newsletters as never,
			interests: EXAMPLE.interests,
			routes: EXAMPLE.routes as never,
			defaultRoute: "obsidian",
		});
	});

	test("the routes are Task for the Steward, Readwise Reader and the Obsidian Reading list, and a fourth is only config", () => {
		const c = parseMail({
			...EXAMPLE,
			routes: [
				...EXAMPLE.routes,
				{ id: "todo", label: "To-do app", kind: "command", command: ["todo-add", "--stdin"] },
			],
		});
		expect(c.routes.map((r) => r.id)).toEqual(["steward", "reader", "obsidian", "todo"]);
		expect(parseMail(EXAMPLE).routes.map((r) => r.label)).toEqual([
			"Task for the Steward",
			"Readwise Reader",
			"Obsidian Reading list",
		]);
	});
});

describe("mail: text leaves the machine only with two switches", () => {
	test("a provider with a reading model is refused unless allowMailToLeaveMachine is true", () => {
		expect(() => parseMail({ provider: "gog" })).toThrow('set "allowMailToLeaveMachine": true');
		expect(() => parseMail({ provider: "gog", allowMailToLeaveMachine: false })).toThrow("reads mail text");
		expect(() => parseMail({ provider: "command", command: { argv: ["x"] } })).toThrow("allowMailToLeaveMachine");
		expect(parseMail({ provider: "gog", allowMailToLeaveMachine: true }).provider).toBe("gog");
	});
	test("rules only (driver none) sends nothing, so it needs no switch", () => {
		expect(parseMail({ provider: "gog", models: { driver: "none" } }).models.driver).toBe("none");
	});
	test("the provider command needs its argv", () => {
		expect(() => parseMail({ provider: "command", allowMailToLeaveMachine: true })).toThrow("needs command.argv");
		const c = parseMail({
			provider: "command",
			allowMailToLeaveMachine: true,
			command: { argv: ["my-mail", "--json"] },
		});
		expect(c.command.argv).toEqual(["my-mail", "--json"]);
	});
});

describe("mail: no credential, and anything it does not understand throws", () => {
	test("there is no key, token or password field, so any is an unknown key", () => {
		for (const key of ["password", "token", "apiKey", "key", "secret", "accessToken", "credentials"])
			expect(() => parseMail({ [key]: "x" })).toThrow(`unknown key "${key}"`);
		for (const key of ["password", "token", "accessToken", "GOG_ACCESS_TOKEN"])
			expect(() => parseMail({ gog: { [key]: "x" } })).toThrow(`unknown key "${key}"`);
	});
	test("gog.env may not name GOG_ACCESS_TOKEN, so the token can never be passed on", () => {
		expect(() => parseMail({ gog: { env: ["GOG_ACCESS_TOKEN"] } })).toThrow("GOG_ACCESS_TOKEN");
		expect(() => parseMail({ gog: { env: ["bad name"] } })).toThrow("not a variable name");
		expect(parseMail({ gog: { env: ["GOG_KEYRING_BACKEND"] } }).gog.env).toEqual(["GOG_KEYRING_BACKEND"]);
	});
	test("every level refuses a key it does not know, a wrong type and an out-of-range number", () => {
		const bad: [unknown, string][] = [
			[[], "expected an object"],
			[{ colour: "blue" }, 'unknown key "colour"'],
			[{ provider: "imap" }, "provider must be one of none, gog, command"],
			[{ mode: "loud" }, "mode must be shadow or live"],
			[{ allowMailToLeaveMachine: "yes" }, "allowMailToLeaveMachine must be true or false"],
			[{ gog: { command: "" } }, "command must be a non-empty string"],
			[{ gog: { flags: [] } }, 'gog: unknown key "flags"'],
			[{ gog: { timeoutMs: 0 } }, "timeoutMs must be a positive whole number"],
			[{ scope: { lookbackDays: 1.5 } }, "lookbackDays must be a positive whole number"],
			[{ scope: { maxMessagesPerRun: -1 } }, "maxMessagesPerRun must be a positive whole number"],
			[{ scope: { query: "" } }, "query must be a non-empty string"],
			[{ labels: { prefix: "a/b" } }, "plain name"],
			[{ labels: { prefix: "" } }, "prefix must be a non-empty string"],
			[{ models: { driver: "haiku; rm" } }, "driver is not a model name"],
			[{ models: { cmd: "x" } }, 'models: unknown key "cmd"'],
			[{ budget: { driverCallsPerRun: 1.5 } }, "driverCallsPerRun must be a non-negative whole number"],
			[{ budget: { topCallsPerRun: 2 } }, "topCallsPerRun must be 0 or 1"],
			[{ budget: { inputTokensPerDay: 0 } }, "inputTokensPerDay must be a positive whole number"],
			[{ important: { senders: "a@b" } }, "expected a list"],
			[{ important: { words: [""] } }, "every entry must be a non-empty string"],
			[{ interests: [1] }, "every entry must be a non-empty string"],
			[{ newsletters: {} }, "expected a list"],
			[{ newsletters: [{ name: "A", match: {} }] }, "exactly one of listId or sender"],
			[{ newsletters: [{ name: "A", match: { listId: "x", sender: "y" } }] }, "exactly one of listId or sender"],
			[{ newsletters: [{ name: "A", match: { listId: "x" }, maxHighlights: 6 }] }, "maxHighlights must be at most 5"],
			[{ newsletters: [{ name: "A", match: { listId: "x" }, extra: 1 }] }, 'unknown key "extra"'],
			[
				{
					newsletters: [
						{ name: "A", match: { listId: "x" } },
						{ name: "A", match: { listId: "y" } },
					],
				},
				"each name must be different",
			],
		];
		for (const [raw, msg] of bad) expect(() => parseMail(raw), JSON.stringify(raw)).toThrow(msg);
	});
});

describe("mail: the unattended-archive floors cannot be configured away", () => {
	test("approval below 95%, a shadow period under 14 days and fewer than 10 batches are refused", () => {
		expect(UNATTENDED_FLOORS).toEqual({ minApproval: 0.95, shadowDays: 14, minBatches: 10 });
		for (const [key, below] of [
			["minApproval", 0.94],
			["shadowDays", 13],
			["minBatches", 9],
		] as const)
			expect(() => parseMail({ cleanup: { unattended: { [key]: below } } })).toThrow(`${key} must be at least`);
	});
	test("a stricter setting is fine, and the sample numbers are checked", () => {
		const u = parseMail({
			cleanup: { unattended: { minApproval: 0.98, shadowDays: 21, minBatches: 30, sampleRate: 1 } },
		}).cleanup.unattended;
		expect(u).toMatchObject({ minApproval: 0.98, shadowDays: 21, minBatches: 30, sampleRate: 1 });
		expect(() => parseMail({ cleanup: { unattended: { minApproval: 1.5 } } })).toThrow("number from 0 to 1");
		expect(() => parseMail({ cleanup: { unattended: { sampleRate: 0 } } })).toThrow(
			"sampleRate must be a positive number",
		);
		expect(() => parseMail({ cleanup: { unattended: { sampleRate: 1.5 } } })).toThrow("above 0 and at most 1");
		expect(() => parseMail({ cleanup: { unattended: { sampleWindow: 0 } } })).toThrow(
			"sampleWindow must be a positive whole",
		);
	});
});

describe("mail.routes", () => {
	const D = MAIL_DEFAULTS.routes;
	test("a route is a steward task, a file or a command; each kind takes only its own key", () => {
		const ok = parseRoutes(
			[
				{ id: "a", label: "A", kind: "steward" },
				{ id: "b", label: "B", kind: "file", file: "~/x.md" },
				{ id: "c", label: "C", kind: "command", command: ["p", "q"] },
			],
			"r",
			D,
		);
		expect(ok.map((r) => r.kind)).toEqual(["steward", "file", "command"]);
		const bad: [unknown, string][] = [
			[[], "1 to 20 routes"],
			[{}, "1 to 20 routes"],
			[[{ id: "a", label: "A", kind: "folder" }], "kind must be one of"],
			[[{ id: "a", label: "A" }], "kind must be one of"],
			[[{ id: "a", label: "A", kind: "steward", file: "x" }], 'unknown key "file"'],
			[[{ id: "a", label: "A", kind: "file" }], "file is required"],
			[[{ id: "a", label: "A", kind: "file", command: ["x"] }], 'unknown key "command"'],
			[[{ id: "a", label: "A", kind: "command" }], "command must be"],
			[[{ id: "a", label: "A", kind: "command", command: [] }], "command must be"],
			[[{ id: "A b", label: "A", kind: "steward" }], "id must be lowercase"],
			[[{ id: "a", label: "", kind: "steward" }], "label must be a non-empty string"],
			[[{ id: "a", kind: "steward" }], "label is required"],
			[[{ label: "A", kind: "steward" }], "id is required"],
			[[{ id: "a", label: "x".repeat(61), kind: "steward" }], "label must be at most 60"],
			[
				[
					{ id: "a", label: "A", kind: "steward" },
					{ id: "a", label: "B", kind: "steward" },
				],
				"its own id",
			],
		];
		for (const [raw, msg] of bad) expect(() => parseRoutes(raw, "r", D), JSON.stringify(raw)).toThrow(msg);
	});
	test("the default route must be one of the routes", () => {
		expect(() => parseMail({ provider: "gog", allowMailToLeaveMachine: true, defaultRoute: "obsidian" })).toThrow(
			'defaultRoute "obsidian" is not one of the routes (steward)',
		);
		// With routes of its own and no defaultRoute named, the first route is the default (the built-in one is not there).
		const c = parseMail({
			provider: "gog",
			allowMailToLeaveMachine: true,
			routes: [{ id: "obsidian", label: "Obsidian Reading list", kind: "file", file: "~/r.md" }],
		});
		expect(c.defaultRoute).toBe("obsidian");
	});
});

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

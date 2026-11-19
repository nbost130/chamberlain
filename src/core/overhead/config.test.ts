import { describe, expect, test } from "bun:test";
import { PRICE } from "../../testing/overhead-fixtures.ts";
import { parseConfigDoc } from "../config/layout-schema.ts";
import { OVERHEAD_DEFAULTS, parseOverhead, perPrConfigured } from "./config.ts";

const prices = { "m-1": PRICE };
const refuses = (section: unknown, message: string | RegExp, steward?: string) =>
	expect(() => parseOverhead(section, steward)).toThrow(message);

describe("defaults are neutral", () => {
	test("no section is the defaults, and nothing in them names a person, a repository, a model or a price", () => {
		const c = parseOverhead(undefined);
		expect(c).toEqual(OVERHEAD_DEFAULTS);
		expect(c.enabled).toBe(false);
		expect(c.github.owners).toEqual([]);
		expect(c.github.repos).toEqual([]);
		expect(c.prices).toEqual({});
		expect(c.fleet.source).toBe("off");
		expect(c.investigator.model).toBeNull();
		expect(c.investigator.projectId).toBeNull();
		expect(JSON.stringify(c)).not.toMatch(/claude|opus|sonnet|haiku|nbost|chamber-hero|spirit/i);
	});

	test("every metric defaults to report-only, so nothing triggers until the operator says so", () => {
		const t = parseOverhead({}).triggers;
		expect([t.costPerPr.mode, t.noopRate.mode, t.spendShare.mode]).toEqual(["report", "report", "report"]);
		expect(t.costPerPr).toEqual({ mode: "report" });
	});

	test("with no owners or repos the per-PR metric is not configured", () => {
		expect(perPrConfigured(parseOverhead({}))).toBe(false);
		expect(perPrConfigured(parseOverhead({ github: { owners: ["acme"] } }))).toBe(true);
		expect(perPrConfigured(parseOverhead({ github: { repos: ["acme/app"] } }))).toBe(true);
	});

	test("the window, baseline and cooldown defaults are 24 h, 7 days, 24 h and one open investigation", () => {
		const c = parseOverhead({});
		expect([c.windowHours, c.baselineDays, c.checkEveryHours]).toEqual([24, 7, 24]);
		expect([c.investigator.cooldownHours, c.investigator.maxOpen]).toEqual([24, 1]);
	});
});

describe("a full section is read", () => {
	test("every key takes its value", () => {
		const c = parseOverhead({
			enabled: true,
			windowHours: 12,
			baselineDays: 14,
			checkEveryHours: 6,
			github: {
				owners: ["acme"],
				repos: ["other/app"],
				excludeRepos: ["acme/docs"],
				countRollups: true,
				rollupTitle: "^Batch",
			},
			prices,
			cacheWrite: "5m",
			fleet: { source: "lifeos", command: "fleet-query", hosts: ["h1"], spawnedProjects: ["evals"] },
			triggers: {
				costPerPr: { mode: "trigger", baselineMultiplier: 2, fixedUsd: 9, zeroPrFloorUsd: 3 },
				noopRate: { mode: "trigger", threshold: 0.2, minWakes: 5 },
				spendShare: { mode: "trigger", threshold: 0.5 },
			},
			investigator: {
				enabled: true,
				model: { adapter: "t3", server: "s", instanceId: "p", model: "x", options: { effort: "high" } },
				projectId: "proj-1",
				title: "Look into overhead",
				cooldownHours: 48,
				maxOpen: 2,
				ttlHours: 24,
				instructions: "Use my worktree tool.",
			},
		});
		expect(c.windowHours).toBe(12);
		expect(c.github).toEqual({
			owners: ["acme"],
			repos: ["other/app"],
			excludeRepos: ["acme/docs"],
			countRollups: true,
			rollupTitle: "^Batch",
		});
		expect(c.triggers.costPerPr).toEqual({ mode: "trigger", baselineMultiplier: 2, fixedUsd: 9, zeroPrFloorUsd: 3 });
		expect(c.investigator.model).toEqual({
			adapter: "t3",
			server: "s",
			instanceId: "p",
			model: "x",
			options: { effort: "high" },
		});
		expect(c.investigator.maxOpen).toBe(2);
		expect(c.investigator.instructions).toBe("Use my worktree tool.");
	});
});

describe("bad values are refused with the key named", () => {
	test("unknown keys, at every level", () => {
		refuses({ nope: 1 }, /overhead: unknown key "nope"/);
		refuses({ github: { nope: 1 } }, /overhead.github: unknown key "nope"/);
		refuses({ triggers: { nope: {} } }, /overhead.triggers: unknown key "nope"/);
		refuses({ triggers: { costPerPr: { nope: 1 } } }, /overhead.triggers.costPerPr: unknown key "nope"/);
		refuses({ investigator: { nope: 1 } }, /overhead.investigator: unknown key "nope"/);
		refuses({ fleet: { nope: 1 } }, /overhead.fleet: unknown key "nope"/);
	});

	test("negative, zero or non-numeric thresholds and spans", () => {
		refuses({ triggers: { costPerPr: { fixedUsd: -1 } } }, /fixedUsd must be a non-negative number/);
		refuses({ triggers: { costPerPr: { baselineMultiplier: 0 } } }, /baselineMultiplier must be a positive number/);
		refuses({ triggers: { costPerPr: { baselineMultiplier: -2 } } }, /baselineMultiplier must be a positive number/);
		refuses({ triggers: { costPerPr: { zeroPrFloorUsd: -5 } } }, /zeroPrFloorUsd must be a non-negative number/);
		refuses({ triggers: { noopRate: { threshold: 0 } } }, /threshold must be a number above 0 and up to 1/);
		refuses({ triggers: { noopRate: { threshold: 1.5 } } }, /threshold must be a number above 0 and up to 1/);
		refuses({ triggers: { noopRate: { threshold: -0.1 } } }, /threshold must be a number above 0 and up to 1/);
		refuses({ triggers: { noopRate: { minWakes: 1.5 } } }, /minWakes must be a positive whole number/);
		refuses({ windowHours: 0 }, /windowHours must be a positive number/);
		refuses({ windowHours: "24" }, /windowHours must be a positive number/);
		refuses({ baselineDays: -7 }, /baselineDays must be a positive number/);
		refuses({ investigator: { cooldownHours: -1 } }, /cooldownHours must be a non-negative number/);
		refuses({ investigator: { maxOpen: 0 } }, /maxOpen must be a positive whole number/);
	});

	test("a mode other than trigger or report", () => {
		refuses({ triggers: { noopRate: { mode: "alarm" } } }, /mode must be one of trigger, report/);
	});

	test("a trigger with nothing to trigger on", () => {
		refuses(
			{ github: { owners: ["a"] }, triggers: { costPerPr: { mode: "trigger" } } },
			/needs baselineMultiplier, fixedUsd or zeroPrFloorUsd/,
		);
		refuses({ triggers: { noopRate: { mode: "trigger" } } }, /noopRate: mode "trigger" needs a threshold/);
		refuses({ triggers: { spendShare: { mode: "trigger" } } }, /spendShare: mode "trigger" needs a threshold/);
		refuses({ triggers: { spendShare: { mode: "trigger", threshold: 0.3 } } }, /needs fleet.source "lifeos"/);
	});

	test("a per-PR trigger with no owners or repos to count", () => {
		refuses({ triggers: { costPerPr: { mode: "trigger", fixedUsd: 5 } } }, /needs github.owners or github.repos/);
	});

	test("names that reach a search or a query must be plain", () => {
		refuses({ github: { owners: ["a b; drop"] } }, /owners must be a list of plain names/);
		refuses({ github: { repos: ["not-a-repo"] } }, /repos must be a list of owner\/name repositories/);
		refuses({ github: { excludeRepos: ["x/y z"] } }, /excludeRepos must be a list of owner\/name repositories/);
		refuses({ fleet: { hosts: ["h'; --"] } }, /hosts must be a list of plain names/);
		refuses({ fleet: { spawnedProjects: ["p'"] } }, /spawnedProjects must be a list of plain names/);
		refuses({ fleet: { command: "x; y" } }, /command must be a plain name/);
		refuses({ investigator: { title: "a'" } }, /title must be a plain name/);
	});

	test("a rollup pattern that is not a regular expression, and a cache write that is not 5m or 1h", () => {
		refuses({ github: { rollupTitle: "(" } }, /rollupTitle is not a valid regular expression/);
		refuses({ cacheWrite: "2h" }, /cacheWrite must be one of 5m, 1h/);
	});

	test("a fleet source that is neither off nor lifeos", () => {
		refuses({ fleet: { source: "datadog" } }, /source must be one of off, lifeos/);
	});

	test("an investigator model that is not a full T3 selection", () => {
		refuses(
			{ investigator: { model: { adapter: "t3", server: "s" } } },
			/overhead.investigator.model: instanceId is required/,
		);
		refuses(
			{ investigator: { model: { adapter: "http", server: "s", instanceId: "p", model: "m" } } },
			/require the t3 adapter/,
		);
	});

	test("an enabled investigator needs a model and a project", () => {
		refuses({ investigator: { enabled: true } }, /investigator: enabled needs model and projectId/);
		refuses({ investigator: { enabled: true, projectId: "p" } }, /enabled needs model and projectId/);
	});
});

describe("the price table", () => {
	test("is refused when empty and the monitor is enabled with PR counting on", () => {
		refuses(
			{ enabled: true, github: { owners: ["a"] } },
			/overhead.prices: enabled with merged-PR counting needs a price table/,
		);
		refuses({ enabled: true, github: { owners: ["a"] }, prices: {} }, /needs a price table/);
	});

	test("is not needed while the monitor is off, or counts no PRs", () => {
		expect(() => parseOverhead({ github: { owners: ["a"] } })).not.toThrow();
		expect(() => parseOverhead({ enabled: true })).not.toThrow();
	});

	test("must list the Steward's model when the monitor is enabled, naming it", () => {
		const section = { enabled: true, github: { owners: ["a"] }, prices };
		refuses(section, /no price for the Steward's model "m-2"/, "m-2");
		expect(() => parseOverhead(section, "m-1")).not.toThrow();
		expect(() => parseOverhead(section, "m-1[1m]")).not.toThrow();
		expect(() => parseOverhead(section, undefined)).not.toThrow();
	});

	test("every model needs all five rates, each zero or more", () => {
		refuses({ prices: { m: { input: 1 } } }, /overhead.prices.m: cacheWrite5m is required/);
		refuses({ prices: { m: { ...PRICE, output: -1 } } }, /overhead.prices.m: output must be a non-negative number/);
		refuses({ prices: { m: { ...PRICE, output: "20" } } }, /output must be a non-negative number/);
		refuses({ prices: { m: { ...PRICE, extra: 1 } } }, /overhead.prices.m: unknown key "extra"/);
		refuses({ prices: { m: 5 } }, /overhead.prices.m: expected an object/);
		expect(() => parseOverhead({ prices: { m: { ...PRICE, cacheRead: 0 } } })).not.toThrow();
	});
});

describe("config.json validation reaches the section", () => {
	test("a bad overhead section fails the whole document, and the steward's model from models.steward is checked against prices", () => {
		expect(() => parseConfigDoc({ overhead: { windowHours: -1 } })).toThrow(/windowHours must be a positive number/);
		const models = { steward: { adapter: "t3", server: "s", instanceId: "p", model: "unpriced", options: {} } };
		const overhead = { enabled: true, github: { owners: ["a"] }, prices };
		expect(() => parseConfigDoc({ models, overhead })).toThrow(/no price for the Steward's model "unpriced"/);
		expect(() => parseConfigDoc({ models: { steward: { ...models.steward, model: "m-1" } }, overhead })).not.toThrow();
		expect(() => parseConfigDoc({ overhead: null })).not.toThrow();
	});
});

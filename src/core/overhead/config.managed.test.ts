import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../../testing/store.ts";
import { parseOverhead } from "./config.ts";
import { ownThreads } from "./settings.ts";
import { recordOpened } from "./trigger.ts";

const refuses = (section: unknown, message: RegExp) => expect(() => parseOverhead(section)).toThrow(message);

describe("triggers.managedRatio", () => {
	test("is report only by default, judged only at 90% coverage", () => {
		expect(parseOverhead(undefined).triggers.managedRatio).toEqual({ mode: "report", minCoverage: 0.9 });
		expect(parseOverhead({ triggers: { managedRatio: { threshold: 0.2 } } }).triggers.managedRatio).toEqual({
			mode: "report",
			threshold: 0.2,
			minCoverage: 0.9,
		});
	});

	test("takes a mode, a threshold and a minimum coverage", () => {
		const t = parseOverhead({
			fleet: { source: "lifeos" },
			triggers: { managedRatio: { mode: "trigger", threshold: 0.25, minCoverage: 0.75 } },
		}).triggers.managedRatio;
		expect(t).toEqual({ mode: "trigger", threshold: 0.25, minCoverage: 0.75 });
	});

	test("refuses a coverage that is not above 0 and up to 1, a threshold that is not above 0, an unknown key and a mode that is neither", () => {
		for (const minCoverage of [0, -0.1, 1.5, "0.9"])
			refuses({ triggers: { managedRatio: { minCoverage } } }, /minCoverage must be a number above 0 and up to 1/);
		refuses({ triggers: { managedRatio: { threshold: 0 } } }, /threshold must be a positive number/);
		refuses({ triggers: { managedRatio: { threshold: -1 } } }, /threshold must be a positive number/);
		refuses({ triggers: { managedRatio: { nope: 1 } } }, /managedRatio: unknown key "nope"/);
		refuses({ triggers: { managedRatio: { mode: "alarm" } } }, /mode must be one of trigger, report/);
	});

	test("a trigger needs a threshold, and the fleet source its spend is read from", () => {
		refuses(
			{ fleet: { source: "lifeos" }, triggers: { managedRatio: { mode: "trigger" } } },
			/managedRatio: mode "trigger" needs a threshold/,
		);
		refuses({ triggers: { managedRatio: { mode: "trigger", threshold: 0.2 } } }, /needs fleet.source "lifeos"/);
	});
});

describe("the threads Chamberlain runs itself", () => {
	test("are the pinned threads, every butler and every investigator, each once", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-own-`);
		try {
			mkdirSync(`${dir}/secrets`, { mode: 0o700 });
			writeFileSync(
				`${dir}/config.json`,
				JSON.stringify({ threads: { steward: "T-steward", decisions: "T-decisions", desk: null } }),
				{ mode: 0o600 },
			);
			const store = memStore();
			store.butlers.insert({
				id: "B-1",
				thread: "T-butler",
				machine: "m",
				model: "x",
				scope: "s",
				started: "2026-11-18T00:00:00Z",
			});
			store.butlers.insert({
				id: "B-2",
				thread: "T-steward",
				machine: "m",
				model: "x",
				scope: "s",
				started: "2026-11-18T00:00:00Z",
			});
			recordOpened(store, { id: "OV-1", openedAt: 1, status: "open", threadId: "T-inv", crossings: [] });
			recordOpened(store, { id: "OV-2", openedAt: 2, status: "pending", crossings: [] });
			const own = ownThreads(dir, store);
			expect(own.pinned).toEqual(["T-steward", "T-decisions"]);
			expect(own.butlers).toEqual(["T-butler", "T-steward"]);
			expect(own.investigators).toEqual(["T-inv"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

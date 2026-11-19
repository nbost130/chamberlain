import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, MODEL, NOW, wake } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { type Launch, overheadTicker } from "./tick.ts";
import { closeInvestigation, readOverheadState } from "./trigger.ts";

const inv = {
	enabled: true,
	model: { adapter: "t3", server: "s", instanceId: "p", model: "m", options: { effort: "high" } },
	projectId: "proj-1",
};
const noop = { mode: "trigger", threshold: 0.1, minWakes: 5 };
const crossing = (extra: Record<string, unknown> = {}) =>
	cfgWith({ enabled: true, investigator: inv, triggers: { noopRate: noop }, ...extra });

/** 10 wakes in the 24 h before `now`, 4 of them no-ops (40%). */
const rows = (now = NOW) =>
	Array.from({ length: 10 }, (_, i) => wake({ hoursAgo: 1 + i, usd: 2, tools: i < 4 ? 0 : 2, now }));

function rig(
	o: {
		cfg?: ReturnType<typeof cfgWith>;
		launch?: Launch | null;
		gh?: () => Promise<unknown>;
		rows?: ReturnType<typeof wake>[];
	} = {},
) {
	const store = memStore();
	store.usage.upsert(o.rows ?? rows());
	const launched: { seed: string; title: string; brief: string }[] = [];
	const logs: { event: string; fields: Record<string, unknown> }[] = [];
	let now = NOW;
	const launch: Launch = async (a) => {
		launched.push(a);
		return { threadId: `thread-${launched.length}` };
	};
	const tick = overheadTicker({
		store,
		cfg: o.cfg ?? crossing(),
		model: MODEL,
		gh: o.gh ?? (async () => ({ total: 0, incomplete: false, items: [] })),
		...(o.launch === null ? {} : { launch: o.launch ?? launch }),
		commands: { note: "chamberlain note", close: "chamberlain overhead close", overhead: "chamberlain overhead" },
		now: () => now,
		log: (event, fields) => logs.push({ event, fields }),
	});
	/** Moves the clock on and, unless the test gave its own rows, adds the same kind of day's wakes before the new time, so the crossing persists. */
	const advance = (ms: number) => {
		now += ms;
		if (!o.rows) store.usage.upsert(rows(now));
	};
	return { store, tick, launched, logs, advance, at: () => now };
}

describe("a crossing opens an investigator", () => {
	test("launches one thread, with a titled brief, and records it as open with its thread", async () => {
		const r = rig();
		await r.tick();
		expect(r.launched).toHaveLength(1);
		const state = readOverheadState(r.store);
		expect(state.investigations).toHaveLength(1);
		const rec = state.investigations[0];
		expect(rec).toMatchObject({ status: "open", threadId: "thread-1", openedAt: NOW });
		expect(rec?.crossings[0]).toContain("no-op wake rate 40.0%");
		expect(r.launched[0]?.seed).toBe(rec?.id as string);
		expect(r.launched[0]?.title).toBe(`Overhead investigation 2026-11-18 ${rec?.id}`);
		expect(r.logs.map((l) => l.event)).toEqual(["overhead-checked", "overhead-investigation"]);
	});

	test("keeps the numbers for the Decisions view, crossing or not", async () => {
		const r = rig({ cfg: cfgWith({ enabled: true, investigator: inv }) });
		await r.tick();
		expect(r.launched).toEqual([]);
		const last = readOverheadState(r.store).last;
		expect(last?.noopRate).toBeCloseTo(0.4, 6);
		expect(last?.crossings).toEqual([]);
		expect(last?.windowLabel).toBe("24 h");
	});

	test("measures once per interval: a second tick inside it does nothing at all", async () => {
		const r = rig();
		await r.tick();
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.logs.filter((l) => l.event === "overhead-checked")).toHaveLength(1);
		expect(r.launched).toHaveLength(1);
	});

	test("the interval is the operator's", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
		await r.tick();
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.logs.filter((l) => l.event === "overhead-checked")).toHaveLength(2);
	});
});

describe("the guards against a feedback loop", () => {
	test("none while one is still open: a crossing the next day is logged as skipped, nothing launches", async () => {
		const r = rig();
		await r.tick();
		r.advance(25 * HOUR);
		await r.tick();
		expect(r.launched).toHaveLength(1);
		const checked = r.logs.filter((l) => l.event === "overhead-checked");
		expect(checked[1]?.fields).toMatchObject({ opened: false, skipped: "open-investigation" });
	});

	test("once closed, still not inside the cooldown; after it, a new one opens", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
		await r.tick();
		const id = readOverheadState(r.store).investigations[0]?.id as string;
		closeInvestigation(r.store, id, { by: "investigator", now: r.at() });
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.launched).toHaveLength(1);
		expect(r.logs.at(-1)?.fields).toMatchObject({ skipped: "cooldown" });
		r.advance(23 * HOUR);
		await r.tick();
		expect(r.launched).toHaveLength(2);
		expect(readOverheadState(r.store).investigations.map((i) => i.status)).toEqual(["closed", "open"]);
	});

	test("an open one that nobody closes expires, and then the next may open", async () => {
		const r = rig({ cfg: crossing({ investigator: { ...inv, ttlHours: 30, cooldownHours: 1 } }) });
		await r.tick();
		r.advance(26 * HOUR);
		await r.tick();
		expect(r.launched).toHaveLength(1);
		r.advance(26 * HOUR);
		await r.tick();
		expect(r.launched).toHaveLength(2);
		expect(readOverheadState(r.store).investigations[0]).toMatchObject({ status: "closed", closedBy: "expired" });
	});

	test("disabled (monitor on, investigator off): the numbers are kept and nothing launches", async () => {
		const r = rig({ cfg: cfgWith({ enabled: true, triggers: { noopRate: noop } }) });
		await r.tick();
		expect(r.launched).toEqual([]);
		expect(r.logs[0]?.fields).toMatchObject({ crossings: 1, opened: false, skipped: "disabled" });
	});
});

describe("a launch that fails", () => {
	test("is recorded as closed, launch-failed, and does not hold the cooldown or the slot: the next interval tries again", async () => {
		let ok = false;
		const calls: string[] = [];
		const launch: Launch = async (a) => {
			calls.push(a.seed);
			if (!ok) throw Error("configured provider is unavailable");
			return { threadId: "t-ok" };
		};
		const r = rig({ launch });
		await r.tick();
		expect(readOverheadState(r.store).investigations[0]).toMatchObject({
			status: "closed",
			closedBy: "launch-failed",
			note: "configured provider is unavailable",
		});
		expect(r.logs.map((l) => l.event)).toEqual(["overhead-checked", "overhead-error"]);
		ok = true;
		r.advance(25 * HOUR);
		await r.tick();
		expect(calls).toHaveLength(2);
		expect(readOverheadState(r.store).investigations.at(-1)).toMatchObject({ status: "open", threadId: "t-ok" });
	});

	test("with no launcher configured the crossing is recorded and says what to set", async () => {
		const r = rig({ launch: null });
		await r.tick();
		const rec = readOverheadState(r.store).investigations[0];
		expect(rec).toMatchObject({ status: "closed", closedBy: "launch-failed" });
		expect(rec?.note).toContain("overhead.investigator.model and projectId");
	});
});

describe("fails closed", () => {
	test("the cost limit is not judged when GitHub cannot be read: no investigator from it", async () => {
		const cfg = cfgWith({
			enabled: true,
			investigator: inv,
			triggers: { costPerPr: { mode: "trigger", fixedUsd: 0.01 } },
		});
		const r = rig({ cfg, gh: async () => Promise.reject(Error("GitHub read failed")) });
		await r.tick();
		expect(r.launched).toEqual([]);
		expect(readOverheadState(r.store).last?.unavailable.join(" ")).toContain("merged PRs");
		expect(readOverheadState(r.store).investigations).toEqual([]);
	});

	test("the share is not judged when the fleet total cannot be read: no investigator from it", async () => {
		const cfg = cfgWith({
			enabled: true,
			investigator: inv,
			fleet: { source: "lifeos" },
			triggers: { spendShare: { mode: "trigger", threshold: 0.0001 } },
		});
		const store = memStore();
		store.usage.upsert(rows());
		const launched: unknown[] = [];
		const tick = overheadTicker({
			store,
			cfg,
			model: MODEL,
			gh: async () => ({ total: 0, incomplete: false, items: [] }),
			query: async () => Promise.reject(Error("LifeOS query failed")),
			launch: async (a) => {
				launched.push(a);
				return { threadId: "t" };
			},
			commands: { note: "n", close: "c", overhead: "o" },
			now: () => NOW,
			log: () => {},
		});
		await tick();
		expect(launched).toEqual([]);
		expect(readOverheadState(store).last).toMatchObject({ fleetStatus: "unavailable" });
	});
});

describe("the brief the investigator gets", () => {
	test("carries what crossed, the numbers, the no-op wakes by kind with example keys, the dearest turns and how to report back", async () => {
		const withKinds = [
			...Array.from({ length: 4 }, (_, i) => ({
				...wake({ hoursAgo: 1 + i, usd: 2 + i, tools: 0, kind: "turn_ended" }),
				deliveryId: `d-ended-${i}`,
			})),
			...Array.from({ length: 2 }, (_, i) => ({
				...wake({ hoursAgo: 6 + i, usd: 1, tools: 0, kind: "stalled" }),
				deliveryId: `d-stalled-${i}`,
			})),
			...Array.from({ length: 6 }, (_, i) => wake({ hoursAgo: 9 + i, usd: 30, tools: 3 })),
		];
		const r = rig({ rows: withKinds });
		await r.tick();
		const brief = r.launched[0]?.brief ?? "";
		const id = r.launched[0]?.seed as string;
		expect(brief).toContain(`Overhead investigation ${id}`);
		expect(brief).toContain("CROSSED");
		expect(brief).toContain("no-op wake rate");
		expect(brief).toContain("THE NUMBERS (the same output as `chamberlain overhead`)");
		expect(brief).toContain("- turn_ended: 4 wakes, $14.00");
		expect(brief).toContain("- stalled: 2 wakes, $2.00");
		expect(brief).toContain("d-ended-3"); // the dearest example of the biggest group
		expect(brief).toMatch(/DEAREST TURNS[\s\S]*\$30\.00/);
		expect(brief).toContain(`chamberlain note --from "Overhead investigator"`);
		expect(brief).toContain(`chamberlain overhead close ${id}`);
		expect(brief).toContain("Do not deploy");
	});

	test("carries the operator's own instructions at the end, and nothing else operator-specific", async () => {
		const r = rig({
			cfg: crossing({ investigator: { ...inv, instructions: "Lease a worktree with the team tool first." } }),
		});
		await r.tick();
		const brief = r.launched[0]?.brief ?? "";
		expect(brief.trimEnd().endsWith("Lease a worktree with the team tool first.")).toBe(true);
		expect(brief).not.toMatch(/nbost|chamber-hero|spirit-media|treehouse|~\/dev/i);
	});

	test("without a price for the Steward's model the brief ranks and shows tokens, not dollars", async () => {
		const r = rig();
		const tick = overheadTicker({
			store: r.store,
			cfg: crossing(),
			model: "unpriced-model",
			gh: async () => ({ total: 0, incomplete: false, items: [] }),
			launch: async (a) => {
				r.launched.push(a);
				return { threadId: "t" };
			},
			commands: { note: "n", close: "c", overhead: "o" },
			now: () => NOW,
			log: () => {},
		});
		await tick();
		expect(r.launched.at(-1)?.brief).toMatch(/k tokens/);
	});
});

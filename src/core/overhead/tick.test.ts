import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, MODEL, NOW, wake } from "../../testing/overhead-fixtures.ts";
import { crossing, fakeT3, heldOf, inv, noop, rig, rows, stateOf } from "../../testing/overhead-tick-rig.ts";
import { memStore } from "../../testing/store.ts";
import { overheadTicker } from "./tick.ts";
import { closeInvestigation, readOverheadState } from "./trigger.ts";

describe("a crossing opens an investigator", () => {
	test("reserves, launches one thread with a titled brief, and records it open with its thread", async () => {
		const r = rig();
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		const rec = stateOf(r).investigations[0];
		expect(rec).toMatchObject({ status: "open", threadId: `thread-${rec?.id}`, openedAt: NOW });
		expect(rec?.brief).toBeUndefined();
		expect(rec?.crossings[0]).toContain("no-op wake rate 40.0%");
		expect(r.t3.launched[0]?.seed).toBe(rec?.id as string);
		expect(r.t3.launched[0]?.title).toBe(`Overhead investigation 2026-11-18 ${rec?.id}`);
		expect(r.logs.map((l) => l.event)).toEqual(["overhead-checked", "overhead-investigation"]);
	});

	test("keeps the numbers for the Decisions view, crossing or not", async () => {
		const r = rig({ cfg: cfgWith({ enabled: true, investigator: inv }) });
		await r.tick();
		expect(r.t3.launched).toEqual([]);
		const last = stateOf(r).last;
		expect(last?.noopRate).toBeCloseTo(0.4, 6);
		expect(last?.crossings).toEqual([]);
		expect(last?.windowLabel).toBe("24 h");
	});

	test("measures once per interval: a second tick inside it does not measure again", async () => {
		const r = rig();
		await r.tick();
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.logs.filter((l) => l.event === "overhead-checked")).toHaveLength(1);
		expect(r.t3.launched).toHaveLength(1);
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
	test("none while one is held: a crossing the next day is logged as skipped, nothing launches", async () => {
		const r = rig();
		await r.tick();
		r.advance(25 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		const checked = r.logs.filter((l) => l.event === "overhead-checked");
		expect(checked[1]?.fields).toMatchObject({ opened: false, skipped: "open-investigation" });
	});

	test("once closed, still not inside the cooldown; after it, a new one opens", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
		await r.tick();
		closeInvestigation(r.store, stateOf(r).investigations[0]?.id as string, { by: "investigator", now: r.at() });
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(r.logs.at(-1)?.fields).toMatchObject({ skipped: "cooldown" });
		r.advance(23 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(2);
		expect(stateOf(r).investigations.map((i) => i.status)).toEqual(["closed", "open"]);
	});

	test("a wall clock that jumps forward does not shorten the cooldown the monotonic clock saw", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
		await r.tick();
		closeInvestigation(r.store, stateOf(r).investigations[0]?.id as string, { by: "investigator", now: r.at() });
		r.advance(2 * HOUR);
		r.jump(40 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(r.logs.at(-1)?.fields).toMatchObject({ skipped: "cooldown" });
	});

	test("disabled (monitor on, investigator off): the numbers are kept and nothing launches", async () => {
		const r = rig({ cfg: cfgWith({ enabled: true, triggers: { noopRate: noop } }) });
		await r.tick();
		expect(r.t3.launched).toEqual([]);
		expect(r.logs[0]?.fields).toMatchObject({ crossings: 1, opened: false, skipped: "disabled" });
	});

	test("at maxOpen 2 and many failed launches, the live reservations are all still tracked and still block a third", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1, investigator: { ...inv, maxOpen: 2, cooldownHours: 0 } }) });
		r.t3.refuse = true;
		for (let i = 0; i < 24; i++) {
			await r.tick();
			r.advance(2 * HOUR);
		}
		expect(stateOf(r).investigations.every((i) => i.closedBy === "launch-failed")).toBe(true);
		expect(stateOf(r).investigations.length).toBeLessThanOrEqual(20);
		r.t3.refuse = false;
		for (let i = 0; i < 4; i++) {
			await r.tick();
			r.advance(2 * HOUR);
		}
		expect(heldOf(r)).toHaveLength(2);
		expect(r.t3.threads.size).toBe(2);
	});
});

describe("fails closed", () => {
	const q = async () => ({ total: 0, incomplete: false, items: [] });
	const run = async (
		section: Record<string, unknown>,
		extra: { query?: () => Promise<string>; gh?: () => Promise<unknown> },
	) => {
		const store = memStore();
		store.usage.upsert(rows());
		const t3 = fakeT3();
		await overheadTicker({
			store,
			cfg: cfgWith({ enabled: true, investigator: inv, ...section }),
			model: MODEL,
			gh: extra.gh ?? q,
			...(extra.query ? { query: extra.query } : {}),
			investigator: t3.investigator,
			commands: { note: "n", close: "c", overhead: "o" },
			now: () => NOW,
			log: () => {},
		})();
		return { t3, store };
	};

	test("the cost limit is not judged when GitHub cannot be read: no investigator from it", async () => {
		const { t3, store } = await run(
			{ triggers: { costPerPr: { mode: "trigger", fixedUsd: 0.01 } } },
			{ gh: () => Promise.reject(Error("GitHub read failed")) },
		);
		expect(t3.launched).toEqual([]);
		expect(readOverheadState(store).last?.unavailable.join(" ")).toContain("merged PRs");
		expect(readOverheadState(store).investigations).toEqual([]);
	});

	test("the share is not judged when the fleet total cannot be read: no investigator from it", async () => {
		const { t3, store } = await run(
			{ fleet: { source: "lifeos" }, triggers: { spendShare: { mode: "trigger", threshold: 0.0001 } } },
			{ query: () => Promise.reject(Error("LifeOS query failed")) },
		);
		expect(t3.launched).toEqual([]);
		expect(readOverheadState(store).last).toMatchObject({ fleetStatus: "unavailable" });
	});

	test("a configured host with no fleet rows makes the share unavailable, so it cannot trigger", async () => {
		const { t3, store } = await run(
			{
				fleet: { source: "lifeos", hosts: ["h1", "h2"] },
				triggers: { spendShare: { mode: "trigger", threshold: 0.0001 } },
			},
			{ query: async () => "k,name,micros\nfleet,h1,400000000" },
		);
		expect(t3.launched).toEqual([]);
		expect(readOverheadState(store).last).toMatchObject({ fleetStatus: "unavailable" });
	});
});

describe("what the investigator is told and what is kept", () => {
	test("the brief carries what crossed, the numbers, the no-op wakes by kind with example keys, the dearest turns and how to report back", async () => {
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
		const brief = r.t3.launched[0]?.brief ?? "";
		const id = r.t3.launched[0]?.seed as string;
		expect(brief).toContain(`Overhead investigation ${id}`);
		expect(brief).toContain("CROSSED");
		expect(brief).toContain("THE NUMBERS (the same output as `chamberlain overhead`)");
		expect(brief).toContain("- turn_ended: 4 wakes, $14.00");
		expect(brief).toContain("- stalled: 2 wakes, $2.00");
		expect(brief).toContain("d-ended-3");
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
		const brief = r.t3.launched[0]?.brief ?? "";
		expect(brief.trimEnd().endsWith("Lease a worktree with the team tool first.")).toBe(true);
		expect(brief).not.toMatch(/nbost|chamber-hero|spirit-media|treehouse|~\/dev/i);
	});

	test("without a price for the Steward's model the brief ranks and shows tokens, not dollars", async () => {
		const store = memStore();
		store.usage.upsert(rows());
		const t3 = fakeT3();
		await overheadTicker({
			store,
			cfg: crossing(),
			model: "unpriced-model",
			gh: async () => ({ total: 0, incomplete: false, items: [] }),
			investigator: t3.investigator,
			commands: { note: "n", close: "c", overhead: "o" },
			now: () => NOW,
			log: () => {},
		})();
		expect(t3.launched.at(-1)?.brief).toMatch(/k tokens/);
	});

	test("a failed read's own text never reaches the report, the stored numbers, the brief or the logs: a dummy credential is redacted", async () => {
		const dummy = `${"gh"}p_${"X".repeat(36)}`;
		const r = rig({
			gh: async () => Promise.reject(Error(`HTTP 401 Bad credentials: Authorization: token ${dummy}`)),
		});
		await r.tick();
		const everything = JSON.stringify({
			state: stateOf(r),
			logs: r.logs.map((l) => ({ ...l, fields: { ...l.fields, error: undefined } })),
			launched: r.t3.launched,
		});
		expect(everything).not.toContain(dummy);
		expect(everything).not.toContain("Bad credentials");
		expect(stateOf(r).last?.unavailable.join(" ")).toContain("merged PRs: unavailable (http-4xx)");
		expect(r.t3.launched[0]?.brief).toContain("UNAVAILABLE: merged PRs: unavailable (http-4xx)");
	});
});

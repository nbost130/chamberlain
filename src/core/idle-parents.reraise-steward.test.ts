/**
 * Stall-detection fixes A and B: re-raise after repeatHours, and one digest when the Steward thread changes.
 * Fixtures shaped like Pilot B/C on 2026-11-15 (same last message for hours).
 */
import { describe, expect, test } from "bun:test";
import { CFG, NOW, rec, sel } from "../testing/core-idle-parents-fixtures.ts";
import { memStore } from "../testing/store.ts";
import {
	idleKey,
	idleParentFindings,
	idleParentsSource,
	idlePrior,
	idleText,
	priorAfterStewardChange,
	repeatMsOf,
	resolveOpenIdleParents,
} from "./idle-parents.ts";
import { runSource } from "./source.ts";

const PILOT_B = "I'm holding until you send C's exact application SHA. No further commits from this thread until then.";
const PILOT_C = "Parked after the Steward rules on PR-G. No reply needed while that ruling is open.";

describe("A: re-raise after repeatHours on the same last message", () => {
	const tick = (store: ReturnType<typeof memStore>, threads: ReturnType<typeof rec>[], now: number) =>
		runSource(
			store,
			idleParentsSource({
				cfg: CFG,
				select: async () => sel(threads),
				prior: () => idlePrior(store),
			}),
			{ now },
		);

	test("a still-open idle finding notifies again after repeatHours (fails on NOTIFY_ONCE main)", async () => {
		const store = memStore();
		const b = rec("pilot-b", 90, PILOT_B, "omar");
		const first = await tick(store, [b], NOW);
		expect(first.notified).toHaveLength(1);
		expect(String(first.notified[0]!.payload.text)).toContain("[WAITING:");
		// Same message, same clock: silent (within the repeat window).
		expect((await tick(store, [b], NOW + 60_000)).notified).toEqual([]);
		// Past repeatHours: one digest line again, with the longer idle time.
		const later = NOW + repeatMsOf(CFG) + 1;
		const bLater = rec("pilot-b", 90 + Math.floor(repeatMsOf(CFG) / 60_000), PILOT_B, "omar");
		const second = await tick(store, [bLater], later);
		expect(second.notified).toHaveLength(1);
		expect(String(second.notified[0]!.payload.text)).toContain(`idle ${bLater.idleMinutes} min`);
		expect(String(second.notified[0]!.payload.text)).toContain("pilot-b");
	});

	test("one pass lists B and C together (no wake storm)", () => {
		const f = idleParentFindings(sel([rec("b", 400, PILOT_B, "omar"), rec("c", 380, PILOT_C, "omar")]), CFG);
		expect(f).toHaveLength(2);
		expect(f.map((x) => x.dedupKey)).toEqual([
			idleKey(rec("b", 400, PILOT_B, "omar")),
			idleKey(rec("c", 380, PILOT_C, "omar")),
		]);
		expect(f.every((x) => x.repeatIntervalMs === repeatMsOf(CFG))).toBe(true);
	});
});

describe("B: Steward change replays open idle findings", () => {
	test("resolving open findings and dropping them from prior makes the next tick notify again", async () => {
		const store = memStore();
		const b = rec("pilot-b", 200, PILOT_B, "omar");
		const c = rec("pilot-c", 180, PILOT_C, "omar");
		const tick = (now: number, priorFn: () => ReturnType<typeof idlePrior>) =>
			runSource(
				store,
				idleParentsSource({
					cfg: CFG,
					select: async () => sel([b, c]),
					prior: priorFn,
				}),
				{ now },
			);
		expect((await tick(NOW, () => idlePrior(store))).notified).toHaveLength(2);
		expect((await tick(NOW + 60_000, () => idlePrior(store))).notified).toEqual([]);
		// Steward switched: resolve open findings (as engine-idle does), then observe without those keys in prior.
		const resolved = resolveOpenIdleParents(store, NOW + 120_000);
		expect(resolved.size).toBe(2);
		const prior = priorAfterStewardChange(idlePrior(store), resolved);
		expect(prior.every((p) => p.resolved || !resolved.has(p.dedupKey))).toBe(true);
		const replay = await tick(NOW + 120_000, () => prior);
		expect(replay.notified).toHaveLength(2);
		expect(replay.notified.map((i) => String(i.payload.text)).join("\n")).toContain("pilot-b");
		expect(replay.notified.map((i) => String(i.payload.text)).join("\n")).toContain("pilot-c");
	});
});

describe("C: wait tag in idle text", () => {
	test("Pilot B and C findings carry [WAITING: …]", () => {
		expect(idleText(rec("b", 100, PILOT_B))).toContain("[WAITING:");
		expect(idleText(rec("c", 100, PILOT_C))).toContain("[WAITING:");
	});
});

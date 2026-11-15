/**
 * Stall-detection fixes A–C: re-raise after repeatHours, Steward-change handoff (uncapped, no reread), wait labels.
 * Fixtures shaped like Pilot B/C on 2026-11-15 (same last message for hours).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CFG, NOW, rec, sel } from "../testing/core-idle-parents-fixtures.ts";
import { memStore } from "../testing/store.ts";
import { createOutbox } from "./deliver.ts";
import { createIdleParents } from "./engine-idle.ts";
import {
	classifiedText,
	idleKey,
	idleParentFindings,
	idleParentsSource,
	idlePrior,
	idleText,
	openIdleParents,
	repeatMsOf,
	resolveOpenIdleParents,
} from "./idle-parents.ts";
import { runSource } from "./source.ts";

const PILOT_B = "I'm holding until you send C's exact application SHA. No further commits from this thread until then.";
const PILOT_C = "Parked after the Steward rules on PR-G. No reply needed while that ruling is open.";

const confDirs: string[] = [];
afterEach(() => {
	for (const d of confDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function confWithSteward(steward: string): string {
	const root = mkdtempSync(join(tmpdir(), "chamberlain-idle-"));
	confDirs.push(root);
	mkdirSync(join(root, "secrets"), { mode: 0o700 });
	writeFileSync(
		join(root, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			threads: { steward, decisions: null },
			sweep: { idleParents: { enabled: true, intervalMinutes: 0.001, thresholdMinutes: 30, maxThreads: 10 } },
		}),
		{ mode: 0o600 },
	);
	return root;
}

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
		expect((await tick(store, [b], NOW + 60_000)).notified).toEqual([]);
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
	test("handoff includes every open finding above maxThreads (Sol P2)", async () => {
		const store = memStore();
		const cfg = { ...CFG, maxThreads: 10 };
		const threads = Array.from({ length: 11 }, (_, i) => rec(`t${i}`, 100 + i, `idle ${i}`, "omar"));
		// First pass with a high cap so all 11 open.
		expect(
			(
				await runSource(
					store,
					idleParentsSource({
						cfg: { ...cfg, maxThreads: 11 },
						select: async () => sel(threads),
						prior: () => idlePrior(store),
					}),
					{ now: NOW },
				)
			).notified,
		).toHaveLength(11);
		const handoff = openIdleParents(store);
		expect(handoff).toHaveLength(11);
		// Pure: without handoff, treating them as new under maxThreads 10 drops one; with handoff, all 11 stay.
		expect(idleParentFindings(sel(threads), cfg, { prior: [] })).toHaveLength(10);
		expect(idleParentFindings(sel(threads), cfg, { prior: [], handoff })).toHaveLength(11);
		// Engine order: snapshot handoff → resolve → observe with handoff (all 11 notify).
		resolveOpenIdleParents(store, NOW + 119_000);
		const afterResolve = await runSource(
			store,
			idleParentsSource({
				cfg,
				select: async () => sel(threads),
				prior: () => idlePrior(store),
				handoff: () => handoff,
			}),
			{ now: NOW + 120_000 },
		);
		expect(afterResolve.notified).toHaveLength(11);
		expect(afterResolve.notified.map((i) => i.dedupKey).sort()).toEqual(threads.map((t) => idleKey(t)).sort());
		// Next pass: quiet (within repeatHours); the 11th stays open, not silently acknowledged away.
		expect(
			(
				await runSource(
					store,
					idleParentsSource({
						cfg,
						select: async () => sel(threads),
						prior: () => idlePrior(store),
					}),
					{ now: NOW + 180_000 },
				)
			).notified,
		).toEqual([]);
		expect(openIdleParents(store)).toHaveLength(11);
	});

	test("handoff replays persisted findings with no reread (Sol P2 disconnected)", async () => {
		const store = memStore();
		const b = rec("pilot-b", 200, PILOT_B, "omar");
		const c = rec("pilot-c", 180, PILOT_C, "omar");
		await runSource(
			store,
			idleParentsSource({
				cfg: CFG,
				select: async () => sel([b, c]),
				prior: () => idlePrior(store),
			}),
			{ now: NOW },
		);
		const handoff = openIdleParents(store);
		expect(handoff).toHaveLength(2);
		// Server disconnected: empty selection, no unreadable list — handoff still carries both.
		const findings = idleParentFindings(sel([]), CFG, { prior: idlePrior(store), handoff });
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.text).join("\n")).toContain("pilot-b");
		expect(findings.map((f) => f.text).join("\n")).toContain("[WAITING:");
		resolveOpenIdleParents(store, NOW + 60_000);
		const notified = await runSource(
			store,
			idleParentsSource({
				cfg: CFG,
				select: async () => sel([]),
				prior: () => idlePrior(store),
				handoff: () => handoff,
			}),
			{ now: NOW + 60_000 },
		);
		expect(notified.notified).toHaveLength(2);
		// Reconnect with same messages: quiet inside the repeat window.
		expect(
			(
				await runSource(
					store,
					idleParentsSource({
						cfg: CFG,
						select: async () => sel([b, c]),
						prior: () => idlePrior(store),
					}),
					{ now: NOW + 90_000 },
				)
			).notified,
		).toEqual([]);
	});

	test("engine handoff commits steward state with the wake (atomic)", async () => {
		const store = memStore();
		const conf = confWithSteward("steward-a");
		const events: { event: string; data?: Record<string, unknown> }[] = [];
		let clock = NOW;
		const b = rec("pilot-b", 200, PILOT_B, "omar");
		const idle = createIdleParents({
			store,
			log: (event, data) => events.push({ event, data }),
			outbox: createOutbox({ store, log: () => {}, now: () => clock }),
			conf,
			sources: () => [],
			skip: () => new Set(),
			now: () => clock,
		});
		// Seed open findings as if a prior pass notified them under steward-a.
		await runSource(
			store,
			idleParentsSource({
				cfg: CFG,
				select: async () => sel([b]),
				prior: () => idlePrior(store),
			}),
			{ now: clock },
		);
		store.state.set("idle-parents-steward", { threadId: "steward-a" });
		store.state.set("idle-parents-clock", { lastAt: clock });
		// Switch steward; next tick with empty sources still replays the persisted finding.
		writeFileSync(
			join(conf, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				threads: { steward: "steward-b", decisions: null },
				sweep: { idleParents: { enabled: true, intervalMinutes: 0.001, thresholdMinutes: 30, maxThreads: 10 } },
			}),
			{ mode: 0o600 },
		);
		clock += 60_000;
		await idle.tick();
		expect(store.state.get<{ threadId: string }>("idle-parents-steward")?.threadId).toBe("steward-b");
		const handoffLog = events.find((e) => e.event === "idle-parents" && e.data?.stewardChanged === true);
		expect(handoffLog?.data?.reported).toBe(1);
		const held = store.wakes.held();
		expect(held.some((w) => w.deliveryId.startsWith("idle-parents:") && w.message.includes("pilot-b"))).toBe(true);
	});
});

describe("C: wait tag in idle text and beside classifier tags", () => {
	test("Pilot B and C findings carry [WAITING: …]", () => {
		expect(idleText(rec("b", 100, PILOT_B))).toContain("[WAITING:");
		expect(idleText(rec("c", 100, PILOT_C))).toContain("[WAITING:");
	});

	test("live escalate and nudge keep [WAITING: …] beside the classifier tag (Sol P2)", () => {
		const hold = "I am holding until you send the SHA.";
		const t = rec("b", 400, hold, "omar");
		for (const action of ["escalate", "nudge"] as const) {
			const text = classifiedText(t, { action, reasons: [{ id: "asks_decision", p: 0.98 }] });
			expect(text).toContain(`[${action.toUpperCase()}`);
			expect(text).toContain("[WAITING:");
			expect(text).toContain("you send the SHA");
		}
	});
});

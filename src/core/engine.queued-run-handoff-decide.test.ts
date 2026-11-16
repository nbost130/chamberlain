/**
 * Opus judge round on #78: no-wake exits must close a handoff as decided (M1), and clearTerminal must keep pending (M2).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCoreEngineFixtures } from "../testing/core-engine-fixtures.ts";
import { HANDOFF_THREAD, handoffScenario, HANDOFF_PLAIN as PLAIN } from "../testing/queued-run-handoff-scenario.ts";
import { createEngine } from "./engine.ts";
import { maintain } from "./maintain.ts";
import { NOTIFICATION_LOG } from "./notification.ts";
import { openStore } from "./sqlite-store.ts";

const fixtures = useCoreEngineFixtures(createEngine);
const { rig } = fixtures;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratchDb = () => {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-handoff-decide-"));
	dirs.push(dir);
	return join(dir, "decide.sqlite");
};

/** Opus M1 scenario A: report budget used → no wake; must not stay pending across restart and 60-day maintain. */
test("handoff decide: report-budget skip closes as confirmed; no re-fire after restart or 60-day maintain", async () => {
	const path = scratchDb();
	const s = openStore(path);
	for (let n = 0; n < 3; n++) s.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey: `report:s20:${n}` });
	await handoffScenario(
		fixtures,
		async ({ r, state, next, advance }) => {
			state(20);
			next();
			state(21);
			await advance(20);
			expect(r.events.some((e) => e.event === "skip-turn-ended")).toBe(true);
			expect(r.fake.wakes).toHaveLength(0);
			expect(s.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
			await r.engine.stop();
			s.close();
			const re = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			const skipsBefore = re.events.filter((e) => e.event === "skip-turn-ended").length;
			for (let i = 0; i < 3; i++) {
				state(21);
				await advance(20);
			}
			expect(re.events.filter((e) => e.event === "skip-turn-ended").length).toBe(skipsBefore);
			await advance(60 * 24 * 3600_000);
			re.clock.t += 60 * 24 * 3600_000;
			maintain(re.store, Date.now());
			expect(re.store.handoffs.get("fake", HANDOFF_THREAD, "r20")).toBeUndefined();
		},
		s,
	);
});

/** Opus M1 scenario B: settled at fire time must not deliver the old final weeks later after a restart. */
test("handoff decide: settled at fire time closes pending; restart after 20 days does not deliver old final", async () => {
	const path = scratchDb();
	await handoffScenario(
		fixtures,
		async ({ r, state, next, advance }) => {
			state(20);
			next();
			state(21);
			state(21, "running", { settled: true });
			await advance(20);
			expect(r.store.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
			expect(r.fake.wakes).toHaveLength(0);
			await r.engine.stop();
			r.store.close();
			const re = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			await advance(20 * 24 * 3600_000);
			re.clock.t += 20 * 24 * 3600_000;
			state(21);
			await advance(20);
			re.clock.t += 31_000;
			await re.engine.tick();
			await advance(20);
			const all = [...r.fake.wakes.map((w) => w.message), ...re.held().map((w) => JSON.stringify(w))].join("\n");
			expect(all).not.toContain(PLAIN);
		},
		openStore(path),
	);
});

/** Sol / Opus M2: multiple pending rows survive a new interval's clearTerminal; all finals recover after restart. */
test("handoff persist: several pending rows; new interval clears terminal without dropping pending finals", async () => {
	const path = scratchDb();
	const s = openStore(path);
	await handoffScenario(
		fixtures,
		async ({ r, state, next, runs, items, advance }) => {
			r.fake.inspect!.handoffSnapshot = async () => {
				throw Error("temporary outage");
			};
			state(20);
			next();
			state(21);
			next(false, 22);
			state(22);
			await advance(20);
			expect(s.handoffs.listPending("fake")).toHaveLength(2);
			s.handoffs.put("fake", {
				threadId: HANDOFF_THREAD,
				runId: "old",
				successorId: "r20",
				disposition: "rejected-human",
			});
			await r.engine.stop();
			s.close();
			const restarted = rig({ store: openStore(path), adapter: r.fake, steward: "steward-1", quietMs: 180_000 });
			r.fake.inspect!.handoffSnapshot = async () => structuredClone({ runs, items });
			state(22);
			next(false, 23);
			state(23);
			expect(restarted.store.handoffs.get("fake", HANDOFF_THREAD, "old")).toBeUndefined();
			expect(restarted.store.handoffs.listPending("fake")).toHaveLength(3);
			items.find((i) => i.id === "a21")!.text = "RUN21 FINAL";
			items.find((i) => i.id === "a22")!.text = "RUN22 FINAL";
			await advance(20);
			for (let i = 0; i < 4; i++) {
				restarted.clock.t += 31_000;
				await restarted.engine.tick();
				await advance(20);
			}
			const all = [...r.fake.wakes.map((w) => w.message), ...restarted.held().map((w) => JSON.stringify(w))].join("\n");
			for (const final of [PLAIN, "RUN21 FINAL", "RUN22 FINAL"]) expect(all).toContain(final);
			for (const run of ["r20", "r21", "r22"])
				expect(restarted.store.handoffs.get("fake", HANDOFF_THREAD, run)?.disposition).toBe("confirmed");
		},
		s,
	);
});

/**
 * Opus M2 / C2: keep load-time repair (maintain may be skipped). Seeds pending+claim, starts without maintain,
 * asserts confirmed and nothing sent. Dropped the redundant fireWith repair branch.
 */
test("handoff repair: loadPending confirms claimed-pending without maintain; nothing is resent", async () => {
	const path = scratchDb();
	const s = openStore(path);
	const key = `${HANDOFF_THREAD}:ended:r20`;
	s.handoffs.put("fake", {
		threadId: HANDOFF_THREAD,
		runId: "r20",
		successorId: "r21",
		disposition: "pending",
	});
	s.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey: key });
	expect(s.items.get(NOTIFICATION_LOG, key)?.notificationCount).toBe(1);
	const { thread } = fixtures;
	const r = rig({ store: s, steward: "steward-1", quietMs: 180_000 });
	await Bun.sleep(30);
	expect(s.handoffs.get("fake", HANDOFF_THREAD, "r20")?.disposition).toBe("confirmed");
	r.fake.emit({ kind: "state", thread: thread(HANDOFF_THREAD, "running", { latestRunId: "r21" }) });
	await Bun.sleep(50);
	expect(r.fake.wakes).toHaveLength(0);
	await r.engine.stop();
	s.close();
});

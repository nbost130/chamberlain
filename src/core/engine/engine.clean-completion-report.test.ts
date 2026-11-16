/** Issue #72: a clean completion's report must not wait out the quiet window (a later human message must not cancel it). */

import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { NOTIFICATION_LOG } from "../items/notification.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);

const IDS = [
	"mcp:9fe168a1-29f5-40f9-b7cb-17fbe83b8df3",
	"mcp:launch:517ca1446df451d43bc2f242b862ba1492dcb07d7cf1961037c3d9a8e6ad1ce1",
] as const;

const PLAIN = "PR #106, head 624d79b4. Tests passed. No merge/deploy.";
const ASK = "Not merged or deployed; waiting on Steward review/land. Say go and I'll continue.";

describe("issue #72: clean completion report survives a human follow-up", () => {
	for (const id of IDS) {
		for (const ordinal of [0, 1] as const) {
			test(`${id} run ordinal ${ordinal}: fires before the follow-up and stays recorded`, async () => {
				const r = rig({ steward: "steward-1", quietMs: 180_000 });
				const instrId = `s-${id}-${ordinal}`;
				const items = [{ ...stewardSigned, id: instrId, text: "Steward here. Fix the thing." }];
				if (ordinal === 1) {
					r.store.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey: `report:${instrId}:0` });
				}
				r.fake.threads.set(id, {
					instruction: { items, state: "complete", byMachine: false },
					lastMessage: PLAIN,
				});
				r.fake.emit({ kind: "state", thread: thread(id, "running") });
				r.fake.emit({ kind: "state", thread: thread(id, "completed") });
				// With the fix: wake after debounce only. Reverting stageClean makes this time out against quietMs.
				await r.until("run 1 report", () => r.fake.wakes.length === 1, 500);
				expect(r.fake.wakes[0]!.message).toContain("finished a turn on the work you sent it and has gone quiet");
				expect(r.engine.notified().has(`report:${instrId}:${ordinal}`)).toBe(true);

				r.fake.threads.set(id, {
					instruction: {
						items: [
							...items,
							{
								type: "user_message",
								id: "human-1",
								text: "is this done?",
								createdBy: "user",
								creationSource: "web",
								updatedAt: new Date().toISOString(),
							},
						],
						state: "complete",
						byMachine: false,
					},
					lastMessage: ASK,
				});
				r.fake.emit({ kind: "state", thread: thread(id, "running") });
				r.fake.emit({ kind: "state", thread: thread(id, "completed") });
				// Ask is still a turn_ended: held while the first post's grace window makes the Steward look busy.
				await r.until(
					"run 2 fired or held",
					() => r.events.filter((e) => e.event === "fire").length >= 2 || r.held().length >= 1,
					500,
				);
				expect(r.engine.notified().has(`report:${instrId}:${ordinal}`)).toBe(true);
				expect(r.events.some((e) => e.event === "skip-report-superseded")).toBe(false);
				r.clock.t += 30_000;
				await r.engine.tick();
				expect(r.fake.wakes.some((w) => w.message.includes("handed a question back"))).toBe(true);
				expect(r.engine.notified().has(`report:${instrId}:${ordinal}`)).toBe(true);
			});
		}
	}

	test("active children still wait out the quiet window", async () => {
		const r = rig({ steward: "steward-1", quietMs: 180_000 });
		const id = "mcp:parent-with-child";
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: "s-child" }], state: "complete", byMachine: false },
			lastMessage: PLAIN,
		});
		r.fake.emit({ kind: "state", thread: thread("child-1", "running", { parentThreadId: id }) });
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
		await r.quiet(80);
		expect(r.fake.wakes).toEqual([]);
		expect(r.events.some((e) => e.event === "fire")).toBe(false);
	});

	test("background work still waits out the quiet window", async () => {
		const r = rig({ steward: "steward-1", quietMs: 180_000 });
		const id = "mcp:parent-with-bg";
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: "s-bg" }], state: "complete", byMachine: false },
			lastMessage: PLAIN,
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { backgroundWork: 1 }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { backgroundWork: 1 }) });
		await r.quiet(80);
		expect(r.fake.wakes).toEqual([]);
		expect(r.events.some((e) => e.event === "fire")).toBe(false);
	});

	test("duplicate state updates do not duplicate the report", async () => {
		const r = rig({ steward: "steward-1", quietMs: 180_000 });
		const id = "mcp:dup-state";
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: "s-dup" }], state: "complete", byMachine: false },
			lastMessage: PLAIN,
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
		await r.until("one report", () => r.fake.wakes.length === 1, 500);
		await r.quiet(80);
		expect(r.fake.wakes).toHaveLength(1);
		expect([...r.engine.notified()].filter((k) => k.startsWith("report:s-dup:"))).toEqual(["report:s-dup:0"]);
	});
});

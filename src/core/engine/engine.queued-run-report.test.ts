/** Issue #74: a run's report must still fire when a queued next run starts with no idle gap. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);

const IDS = [
	"mcp:9fe168a1-29f5-40f9-b7cb-17fbe83b8df3",
	"mcp:launch:f707bc64a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef123456",
] as const;

const PLAIN = "head df704346, checks green. No merge/deploy.";
const ASK = "Waiting on Steward review/land. Say go and I'll continue.";

describe("issue #74: queued handoff still yields the completed run's report", () => {
	for (const id of IDS) {
		test(`${id}: LIVE→LIVE within 1s fires exactly one wake for run N`, async () => {
			const r = rig({ steward: "steward-1", quietMs: 180_000 });
			const instrId = `s-${id}-n`;
			r.fake.threads.set(id, {
				instruction: {
					items: [{ ...stewardSigned, id: instrId, text: "Steward here. Gate round 5.", runId: "run-20" }],
					state: "complete",
					byMachine: false,
				},
				lastMessage: PLAIN,
				runMessages: { "run-20": PLAIN },
				runs: [
					{ id: "run-20", ordinal: 20, status: "completed" },
					{ id: "run-21", ordinal: 21, status: "running" },
				],
			});
			r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-20" }) });
			// Queued run 21 starts with no idle gap (Omar / Pilot C #701). Reverting the decide handoff makes this time out.
			r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-21" }) });
			await r.until("run N report", () => r.fake.wakes.length === 1, 500);
			expect(r.fake.wakes[0]!.message).toContain("finished a turn on the work you sent it and has gone quiet");
			expect(r.fake.wakes[0]!.message).toContain(PLAIN);
			expect(r.engine.notified().has(`report:${instrId}:0`)).toBe(true);
			await r.quiet(80);
			expect(r.fake.wakes).toHaveLength(1);
		});
	}

	test("an idle gap still yields exactly one wake (no duplicate from both paths)", async () => {
		const r = rig({ steward: "steward-1", quietMs: 180_000 });
		const id = "mcp:idle-gap-no-dup";
		r.fake.threads.set(id, {
			instruction: {
				items: [{ ...stewardSigned, id: "s-gap", runId: "run-1" }],
				state: "complete",
				byMachine: false,
			},
			lastMessage: PLAIN,
			runMessages: { "run-1": PLAIN },
			runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-1" }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { latestRunId: "run-1" }) });
		await r.until("idle-gap report", () => r.fake.wakes.length === 1, 500);
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-2" }) });
		await r.quiet(80);
		expect(r.fake.wakes).toHaveLength(1);
		expect([...r.engine.notified()].filter((k) => k.startsWith("report:s-gap:"))).toEqual(["report:s-gap:0"]);
	});

	test("a human-started run N+1 after an idle gap keeps today's behaviour", async () => {
		const r = rig({ steward: "steward-1", quietMs: 180_000 });
		const id = "mcp:human-next-run";
		r.fake.threads.set(id, {
			instruction: {
				items: [{ ...stewardSigned, id: "s-human", runId: "run-1" }],
				state: "complete",
				byMachine: false,
			},
			lastMessage: PLAIN,
			runMessages: { "run-1": PLAIN },
			runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-1" }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { latestRunId: "run-1" }) });
		await r.until("run 1 report", () => r.fake.wakes.length === 1, 500);
		expect(r.engine.notified().has("report:s-human:0")).toBe(true);

		r.fake.threads.set(id, {
			instruction: {
				items: [
					{ ...stewardSigned, id: "s-human", runId: "run-1" },
					{
						type: "user_message",
						id: "human-1",
						runId: "run-2",
						text: "continue?",
						createdBy: "user",
						creationSource: "web",
						updatedAt: new Date().toISOString(),
					},
				],
				state: "complete",
				byMachine: false,
			},
			lastMessage: ASK,
			runMessages: { "run-1": PLAIN, "run-2": ASK },
			runs: [
				{ id: "run-1", ordinal: 1, status: "completed" },
				{ id: "run-2", ordinal: 2, status: "completed" },
			],
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-2" }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { latestRunId: "run-2" }) });
		await r.until(
			"run 2 ask fired or held",
			() => r.events.filter((e) => e.event === "fire").length >= 2 || r.held().length >= 1,
			500,
		);
		expect(r.engine.notified().has("report:s-human:0")).toBe(true);
		r.clock.t += 30_000;
		await r.engine.tick();
		expect(r.fake.wakes.some((w) => w.message.includes("handed a question back"))).toBe(true);
	});
});

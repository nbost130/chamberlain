import { expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";
import { failureFreshness } from "./failure-freshness.ts";

const { rig, thread } = useCoreEngineFixtures(createEngine);

test("a delayed Claude failure after Grok recovered produces no wake; a new real failure still wakes", async () => {
	const r = rig();
	r.fake.threads.set("work", {
		look: { latestRunId: "grok-success", latestStatus: "completed", active: false, waiting: false },
	});
	r.fake.emit({ kind: "state", thread: thread("work", "failed", { latestRunId: "claude-old" }) });
	await r.quiet();
	expect(r.fake.wakes).toHaveLength(0);
	r.fake.threads.set("work", {
		look: { latestRunId: "grok-failed", latestStatus: "failed", active: false, waiting: false },
	});
	r.fake.emit({ kind: "state", thread: thread("work", "running", { latestRunId: "grok-failed" }) });
	r.fake.emit({ kind: "state", thread: thread("work", "failed", { latestRunId: "grok-failed" }) });
	await r.until("new failure wake", () => r.fake.wakes.length === 1);
});

test("active recovery and unreadable source hold failure work instead of claiming recovery", async () => {
	const r = rig();
	r.fake.threads.set("work", { look: { latestRunId: "grok", latestStatus: "running", active: true, waiting: false } });
	expect(await failureFreshness(r.fake.inspect, "work")).toBe("wait");
	const inspect = {
		...r.fake.inspect!,
		look: async () => {
			throw Error("offline");
		},
	};
	expect(await failureFreshness(inspect, "work")).toBe("wait");
});

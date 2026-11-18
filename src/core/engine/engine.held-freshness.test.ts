/** Held turn-end reports are never dropped; the digest notes what the engine saw of each one's thread since. */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));
const RUN = (id: string, n: number) => `run:thread:${id}:ordinal:${n}`;

describe("held turn-end reports and what their thread did since", () => {
	const ended = (r: ReturnType<typeof rig>, id: string, n: number) => {
		const run = RUN(id, n);
		r.fake.threads.set(id, {
			instruction: {
				items: [{ ...stewardSigned, id: `s-${id}-${n}`, runId: run }],
				state: "complete",
				byMachine: false,
			},
			lastMessage: `${id} finished run ${n}.`,
			runMessages: { [run]: `${id} finished run ${n}.` },
			runs: [{ id: run, ordinal: n, status: "completed" }],
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: RUN(id, n) }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { latestRunId: RUN(id, n) }) });
	};
	const digest = async (r: ReturnType<typeof rig>) => {
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.until("the digest", () => posts(r).some((w) => w.deliveryId.startsWith("digest:")));
		return posts(r).find((w) => w.deliveryId.startsWith("digest:"))!.message;
	};
	const itemLine = (message: string, thread: string) =>
		message.split("\n").find((l) => l.startsWith("=== item") && l.includes(`${thread}:ended:`))!;

	test("an untouched thread gets no note; a thread that started another run says so, and keeps its report", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t2", 1);
		ended(r, "t3", 1);
		await r.until("two held", () => r.held().length === 2);
		// t3 starts its next run while the Steward is busy: a quick turn whose own report may never come.
		r.fake.emit({ kind: "state", thread: thread("t3", "running", { latestRunId: RUN("t3", 2) }) });
		await r.until("t3 seen running", () => r.engine.watchers[0]!.states.get("t3")?.status === "running");
		const m = await digest(r);
		expect(itemLine(m, "t2")).not.toContain("seen at");
		expect(itemLine(m, "t3")).toMatch(/seen at \d\d:\d\d UTC: a newer run of its thread has started/);
		expect(m).toContain('thread "Thread t3"');
	});

	test("a hand-off from one running run to the next (no idle gap) is a newer run, not a current report", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t4", 1);
		ended(r, "t5", 1);
		await r.until("two held", () => r.held().length === 2);
		r.fake.emit({ kind: "state", thread: thread("t5", "running", { latestRunId: RUN("t5", 2) }) });
		r.fake.emit({ kind: "state", thread: thread("t5", "running", { latestRunId: RUN("t5", 3) }) });
		await r.until("t5 on run 3", () => r.engine.watchers[0]!.states.get("t5")?.latestRunId === RUN("t5", 3));
		const m = await digest(r);
		expect(itemLine(m, "t5")).toContain("a newer run of its thread has started");
	});

	test("a settled thread's report still arrives, marked settled", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t6", 1);
		ended(r, "t7", 1);
		await r.until("two held", () => r.held().length === 2);
		r.fake.emit({ kind: "state", thread: thread("t6", "completed", { latestRunId: RUN("t6", 1), settled: true }) });
		await r.until("t6 settled", () => r.engine.watchers[0]!.states.get("t6")?.settled === true);
		const m = await digest(r);
		expect(itemLine(m, "t6")).toContain("its thread is settled");
		expect(m).toContain('thread "Thread t6"');
	});

	test("with its server disconnected, nothing new is noted", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t8", 1);
		ended(r, "t9", 1);
		await r.until("two held", () => r.held().length === 2);
		r.fake.setConnected(false);
		const m = await digest(r);
		expect(itemLine(m, "t8")).not.toContain("seen at");
	});
});

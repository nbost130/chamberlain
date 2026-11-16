/** recover, continued: see recover.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { rig, STREAM, t } from "../../testing/core-recover-fixtures.ts";
import type { RunLook } from "../adapter/adapter-inspect.ts";
import { MIN } from "./recover-classify.ts";

describe("what holds a retry back at the moment of the attempt", () => {
	const failedLook = async (): Promise<RunLook> => ({
		latestRunId: "run-1",
		latestStatus: "failed",
		active: false,
		waiting: false,
	});
	const standDowns = (x: ReturnType<typeof rig>) =>
		x.logs.filter((l) => l.event === "recover-stand-down").map((l) => l.data?.why);

	test("a thread the daemon can no longer see is not retried, and the Steward hears of it", async () => {
		const x = rig({ look: failedLook });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.states.delete("t1");
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(standDowns(x)).toEqual(["the daemon cannot see the thread"]);
		expect(x.wakes).toEqual([
			{
				threadId: "t1",
				kind: "stream_closed",
				note: "the automatic retry was held back because the daemon could not see the thread, so nothing has been retried",
			},
		]);
	});

	test("a thread the daemon holds as no longer failed is left alone, with no wake", async () => {
		const x = rig({ look: failedLook });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		x.states.set("t1", t({ status: "running", latestRunId: "run-1" }));
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(standDowns(x)).toEqual(["the thread is running, not failed"]);
		expect(x.wakes).toEqual([]);
	});

	test("children that appear during the grace stop the retry, saying so", async () => {
		let reads = 0;
		const x = rig({ look: failedLook, ctxOver: { children: async () => (reads++ === 0 ? 0 : 2) } });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		await x.advance(4 * MIN);
		expect(x.pings).toEqual([]);
		expect(standDowns(x)).toEqual(["waiting: children are running"]);
	});

	test("a failure the backend cannot be asked about is logged, and nothing is retried", async () => {
		const x = rig({
			ctxOver: {
				readFailure: async () => {
					throw Error("backend down");
				},
			},
		});
		expect(await x.fail("t1", { runId: "run-1", ...STREAM })).toMatchObject({
			action: "wake",
			note: "the failure could not be read, so nothing was retried automatically",
		});
		expect(x.logs.find((l) => l.event === "recover-read-failed")?.data).toEqual({
			threadId: "t1",
			error: "Error: backend down",
		});
	});

	test("with no timer given, the retry goes out on the real clock", async () => {
		const x = rig({ ctxOver: { setTimer: undefined, timing: { graceMs: 5 } } });
		await x.fail("t1", { runId: "run-1", ...STREAM });
		for (let n = 0; n < 100 && x.pings.length === 0; n++) await Bun.sleep(20);
		expect(x.pings.map((p) => p.seed)).toEqual(["recover:t1:run-1"]);
		x.r.stop();
	});
});

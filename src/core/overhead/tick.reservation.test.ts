/** The reservation record under lost outcomes, restarts, stale threads and clock jumps: the launch must never become a second launch. */
import { describe, expect, test } from "bun:test";
import { HOUR } from "../../testing/overhead-fixtures.ts";
import { crossing, heldOf, inv, type Rig, rig, stateOf, type Thread } from "../../testing/overhead-tick-rig.ts";

const quick = () => crossing({ checkEveryHours: 1, investigator: { ...inv, cooldownHours: 1 } });

describe("a launch whose outcome is lost is not launched twice", () => {
	test("T3 accepts the thread and its brief, the response is lost: it stays pending, and a restart finds the thread and opens it", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseResponse = true;
		await r.tick();
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "pending" });
		expect(heldOf(r)).toHaveLength(1);
		expect(r.t3.threads.size).toBe(1);

		// Two hours on, past the cooldown, across a restart: the crossing is still there, and still no second thread.
		r.t3.loseResponse = false;
		r.advance(2 * HOUR);
		r.restart();
		await r.tick();
		expect(r.t3.threads.size).toBe(1);
		expect(r.t3.launched).toHaveLength(1);
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({
			status: "open",
			threadId: expect.stringContaining("thread-OV-"),
		});
		expect(stateOf(r).investigations[0]?.brief).toBeUndefined();
	});

	test("the thread was made but its brief never arrived: the reconciliation sends the same brief once, to the same thread", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseBrief = true;
		await r.tick();
		const seed = r.t3.launched[0]?.seed as string;
		expect(r.t3.threads.get(seed)?.briefSent).toBe(false);
		r.t3.loseBrief = false;
		r.advance(2 * HOUR);
		r.restart();
		await r.tick();
		expect(r.t3.launched.map((l) => l.seed)).toEqual([seed, seed]);
		expect(r.t3.launched[1]?.brief).toBe(r.t3.launched[0]?.brief as string);
		expect(r.t3.threads.size).toBe(1);
		expect(r.t3.threads.get(seed)?.briefSent).toBe(true);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "open" });
	});

	test("a launch that failed with no thread made is retried under the same seed, not under a new one", async () => {
		const r = rig({ cfg: crossing({ investigator: { ...inv, cooldownHours: 1 } }) });
		r.t3.loseBrief = true;
		await r.tick();
		r.t3.threads.clear(); // T3 never saw the create
		r.t3.loseBrief = false;
		r.advance(25 * HOUR);
		await r.tick();
		expect(new Set(r.t3.launched.map((l) => l.seed)).size).toBe(1);
		expect(r.t3.threads.size).toBe(1);
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "open" });
	});

	test("while T3 cannot say, the reservation stays held for as long as that lasts: an unknown outcome counts as launched", async () => {
		const r = rig({ cfg: crossing({ investigator: { ...inv, cooldownHours: 1 } }) });
		r.t3.loseResponse = true;
		await r.tick();
		r.t3.inspectFails = true;
		for (let day = 0; day < 5; day++) {
			r.advance(25 * HOUR);
			await r.tick();
		}
		expect(r.t3.launched).toHaveLength(1);
		expect(heldOf(r)).toHaveLength(1);
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).last?.unavailable.join(" ")).toContain("launch outcome not confirmed");
	});

	test("only a launch that sent nothing releases the reservation, and it holds neither the slot nor the cooldown", async () => {
		const r = rig();
		r.t3.refuse = true;
		await r.tick();
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "closed", closedBy: "launch-failed" });
		expect(stateOf(r).investigations[0]?.brief).toBeUndefined();
		expect(r.logs.map((l) => l.event)).toEqual(["overhead-checked", "overhead-error"]);
		r.t3.refuse = false;
		r.advance(25 * HOUR);
		await r.tick();
		expect(stateOf(r).investigations.at(-1)).toMatchObject({ status: "open" });
	});

	test("with no investigator configured the crossing is recorded as a launch that sent nothing", async () => {
		const r = rig({ investigator: null });
		await r.tick();
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "closed", closedBy: "launch-failed" });
	});
});

describe("a stale investigation is held until T3 says it is done", () => {
	const later = async (r: Rig, hours: number) => {
		r.advance(hours * HOUR);
		await r.tick();
	};
	const started = async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1, investigator: { ...inv, cooldownHours: 1, ttlHours: 72 } }) });
		await r.tick();
		return r;
	};

	test("past the TTL with its thread still running: still held, no second launch, reported stale", async () => {
		const r = await started();
		await later(r, 80);
		expect(r.t3.launched).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "open" });
		expect(stateOf(r).last?.unavailable.join(" ")).toContain("is stale: held 80 h, past 72 h");
		expect(r.logs.at(-1)?.fields).toMatchObject({ skipped: "open-investigation" });
	});

	test("a wall clock that jumps a month ahead with T3 not answering frees nothing", async () => {
		const r = await started();
		r.t3.inspectFails = true;
		r.jump(30 * 24 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(heldOf(r)).toHaveLength(1);
	});

	test("once T3 shows the thread idle, archived or gone, it is closed as expired and the next may open", async () => {
		for (const done of ["idle", "archived", "gone"] as const) {
			const r = await started();
			const seed = r.t3.launched[0]?.seed as string;
			if (done === "idle") (r.t3.threads.get(seed) as Thread).active = false;
			if (done === "archived") (r.t3.threads.get(seed) as Thread).archived = true;
			if (done === "gone") r.t3.threads.delete(seed);
			await later(r, 80);
			expect(stateOf(r).investigations[0]).toMatchObject({ status: "closed", closedBy: "expired" });
			expect(r.t3.launched).toHaveLength(2);
			expect(heldOf(r)).toHaveLength(1);
		}
	});

	test("before the TTL, an idle thread is not closed by the clock or by T3's word: it is the investigator's to close", async () => {
		const r = await started();
		(r.t3.threads.get(r.t3.launched[0]?.seed as string) as Thread).active = false;
		await later(r, 30);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "open" });
		expect(r.t3.launched).toHaveLength(1);
	});
});

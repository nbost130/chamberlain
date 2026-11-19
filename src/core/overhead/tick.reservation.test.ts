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

	test("with no investigator configured the crossing reserves nothing: there is no thread to reconcile a reservation against", async () => {
		const r = rig({ investigator: null });
		await r.tick();
		expect(stateOf(r).investigations).toEqual([]);
		expect(r.logs[0]?.fields).toMatchObject({ opened: false, skipped: "no-investigator" });
	});
});

describe("a reservation leaves pending only when T3 positively shows no thread", () => {
	const ten = (r: Rig) => r.advance(10 * 60_000);

	test("a retry whose preflight is refused keeps the reservation whose thread T3 already made: no second live investigator", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseBrief = true; // T3 made the thread, the brief never arrived
		await r.tick();
		expect(r.t3.threads.size).toBe(1);
		r.t3.loseBrief = false;
		r.t3.refuse = true; // the retry's preflight is refused
		ten(r);
		await r.tick();
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "pending" });
		expect(heldOf(r)).toHaveLength(1);
		// the next measurement sees the held slot, and opens nothing
		r.advance(2 * HOUR);
		await r.tick();
		expect(r.logs.at(-1)?.fields).toMatchObject({ skipped: "open-investigation" });
		expect(r.t3.threads.size).toBe(1);
		// once the preflight passes, the same thread gets its brief
		r.t3.refuse = false;
		ten(r);
		await r.tick();
		expect(stateOf(r).investigations[0]).toMatchObject({
			status: "open",
			threadId: expect.stringContaining("thread-OV-"),
		});
		expect(r.t3.threads.size).toBe(1);
	});

	test("a first launch refused while T3 cannot say whether a thread exists stays held; it is released when T3 answers that none does", async () => {
		const r = rig({ cfg: quick() });
		r.t3.refuse = true;
		r.t3.inspectFails = true;
		await r.tick();
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "pending" });
		expect(heldOf(r)).toHaveLength(1);
		r.t3.inspectFails = false;
		ten(r);
		await r.tick();
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "closed", closedBy: "launch-failed" });
		expect(heldOf(r)).toHaveLength(0);
	});

	test("a refusal with a thread that exists but has no brief releases nothing, however often it repeats", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseBrief = true;
		await r.tick();
		r.t3.loseBrief = false;
		r.t3.refuse = true;
		for (let i = 0; i < 5; i++) {
			ten(r);
			await r.tick();
		}
		expect(heldOf(r)).toHaveLength(1);
		expect(r.t3.threads.size).toBe(1);
	});
});

describe("with the investigator disabled, reconciliation only observes and closes", () => {
	const off = () => crossing({ investigator: { ...inv, enabled: false } });
	/** A ticker with the investigator disabled over the state the enabled one left. */
	const disabledOver = (r: Rig) => rig({ cfg: off(), store: r.store, t3: r.t3 });

	test("a pending reservation whose thread has no brief is not launched again: no command, no brief, still held", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseBrief = true;
		await r.tick();
		r.t3.loseBrief = false;
		const sent = r.t3.launched.length;
		const d = disabledOver(r);
		await d.tick();
		expect(r.t3.launched).toHaveLength(sent);
		expect(r.t3.threads.get(r.t3.launched[0]?.seed as string)?.briefSent).toBe(false);
		expect(heldOf(d)).toHaveLength(1);
		expect(stateOf(d).investigations[0]).toMatchObject({ status: "pending" });
	});

	test("a pending reservation whose thread has its brief is opened, and one whose thread does not exist is closed; neither launches", async () => {
		const r = rig({ cfg: quick() });
		r.t3.loseResponse = true;
		await r.tick();
		const sent = r.t3.launched.length;
		const d = disabledOver(r);
		await d.tick();
		expect(stateOf(d).investigations[0]).toMatchObject({ status: "open" });

		const g = rig({ cfg: quick() });
		g.t3.loseBrief = true;
		await g.tick();
		g.t3.threads.clear(); // T3 never saw the create
		const gSent = g.t3.launched.length;
		const dg = disabledOver(g);
		await dg.tick();
		expect(stateOf(dg).investigations[0]).toMatchObject({ status: "closed", closedBy: "launch-failed" });
		expect(r.t3.launched).toHaveLength(sent);
		expect(g.t3.launched).toHaveLength(gSent);
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

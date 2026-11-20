/**
 * The cooldown is measured from the STORED launch time: restarts add nothing, a clock that reads before it means the cooldown is not over, and
 * inside one process the monotonic clock is read too and the larger of the two is taken. A real forward jump of the wall clock is accepted as time.
 */
import { describe, expect, test } from "bun:test";
import { HOUR } from "../../testing/overhead-fixtures.ts";
import { crossing, inv, type Rig, rig, stateOf } from "../../testing/overhead-tick-rig.ts";
import { closeInvestigation } from "./trigger.ts";

const lastLog = (r: Rig) => r.logs.at(-1)?.fields;

/** A rig whose first investigation is opened and then closed by the investigator, so only the cooldown holds the next one back. */
async function closed(cooldownHours?: number) {
	const r = rig({
		cfg: crossing({
			checkEveryHours: 1,
			...(cooldownHours ? { investigator: { ...inv, cooldownHours } } : {}),
		}),
	});
	await r.tick();
	closeInvestigation(r.store, stateOf(r).investigations[0]?.id as string, { by: "investigator", now: r.at() });
	return r;
}

describe("a restart adds nothing to the cooldown", () => {
	test("restarts with the wall clock going back and forth by an hour never accumulate: 30 cycles, no second launch", async () => {
		const r = await closed();
		for (let i = 0; i < 30; i++) {
			r.jump(-HOUR);
			r.restart();
			await r.tick();
			r.jump(HOUR);
			r.restart();
			await r.tick();
		}
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
	});

	test("the stored launch time is all a restart has: 23 h later across three restarts it is still running, at 24 h it is over", async () => {
		const r = await closed();
		for (let i = 0; i < 3; i++) {
			r.advance(7 * HOUR + 40 * 60_000);
			r.restart();
			await r.tick();
		}
		expect(stateOf(r).investigations[0]?.openedAt).toBe(r.at() - 23 * HOUR);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
		r.advance(HOUR + 60_000);
		r.restart();
		await r.tick();
		expect(r.t3.launched).toHaveLength(2);
	});
});

describe("a clock that reads before the stored launch means the cooldown is not over", () => {
	test("in the process that made it, even when the monotonic clock says a day passed", async () => {
		const r = await closed();
		r.advance(30 * HOUR);
		r.jump(-60 * HOUR); // the clock now reads before the launch
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
	});

	test("after a restart, and while it stays before the launch time", async () => {
		const r = await closed();
		r.jump(-5 * HOUR);
		r.restart();
		await r.tick();
		r.advance(4 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
	});
});

describe("the launch time is read at the launch call, not at the start of the tick", () => {
	test("a measurement that takes 2 h before the launch does not shorten the cooldown, in this process or after a restart", async () => {
		let slow = true;
		const r: Rig = rig({
			cfg: crossing({ checkEveryHours: 1 }),
			gh: async () => {
				if (slow) r.advance(2 * HOUR); // the collection is slow: both clocks move before the launch call
				slow = false;
				return { total: 0, incomplete: false, items: [] };
			},
		});
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		const first = stateOf(r).investigations[0];
		expect(first?.launchedAt).toBe(r.at());
		closeInvestigation(r.store, first?.id as string, { by: "investigator", now: r.at() });
		r.advance(23 * HOUR); // 25 h after the tick started, 23 h after the launch
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
		r.restart();
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		r.advance(HOUR + 60_000);
		await r.tick();
		expect(r.t3.launched).toHaveLength(2);
	});
});

describe("inside one process, the larger of the monotonic and wall-clock time is taken", () => {
	test("a wall clock that stepped back after the launch does not hide the time the monotonic clock saw", async () => {
		const r = await closed(9);
		r.advance(10 * HOUR);
		r.jump(-3 * HOUR); // wall: 7 h since the launch; monotonic: 10 h
		await r.tick();
		expect(r.t3.launched).toHaveLength(2);
	});

	test("and below the cooldown on both, it holds", async () => {
		const r = await closed(9);
		r.advance(6 * HOUR);
		r.jump(-1 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
	});
});

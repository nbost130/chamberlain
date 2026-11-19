/** The cooldown's persisted clock: it survives a restart, and a wall clock that jumps or goes backwards never makes it shorter. */
import { describe, expect, test } from "bun:test";
import { HOUR } from "../../testing/overhead-fixtures.ts";
import { crossing, type Rig, rig, stateOf } from "../../testing/overhead-tick-rig.ts";
import { closeInvestigation } from "./trigger.ts";

const lastLog = (r: Rig) => r.logs.at(-1)?.fields;

/** A rig whose first investigation is opened and then closed by the investigator, so only the cooldown holds the next one back. */
async function closed() {
	const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
	await r.tick();
	closeInvestigation(r.store, stateOf(r).investigations[0]?.id as string, { by: "investigator", now: r.at() });
	return r;
}

describe("the cooldown survives a restart and a clock that jumps", () => {
	test("a restart followed by a wall clock that jumps forward does not end the cooldown", async () => {
		const r = await closed();
		r.restart(); // the monotonic reading is gone with the process
		r.jump(40 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
	});

	test("the reservation's launch time and the clock are kept in the stored state, not in the process", async () => {
		const r = rig({ cfg: crossing({ checkEveryHours: 1 }) });
		await r.tick();
		const s = stateOf(r);
		expect(s.investigations[0]).toMatchObject({ openedAt: r.at(), openedClock: 0 });
		expect(s.clock).toEqual({ at: r.at(), ms: 0 });
		r.advance(3 * HOUR);
		await r.tick();
		expect(stateOf(r).clock).toEqual({ at: r.at(), ms: 3 * HOUR });
	});

	test("a clock that goes backwards, then restarts and forward jumps, still holds the cooldown", async () => {
		const r = await closed();
		r.jump(-5 * HOUR);
		r.restart();
		await r.tick();
		r.advance(30 * HOUR);
		r.restart();
		r.jump(60 * HOUR);
		await r.tick();
		expect(r.t3.launched).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
	});

	test("a clock that goes backwards makes the cooldown longer, not shorter: it is still running at the old wall time", async () => {
		const r = await closed();
		r.jump(-5 * HOUR);
		await r.tick();
		expect(lastLog(r)).toMatchObject({ skipped: "cooldown" });
		expect(r.t3.launched).toHaveLength(1);
	});

	test("after the cooldown has really passed, with ticks vouching for it, a new one opens", async () => {
		const r = await closed();
		for (let i = 0; i < 25; i++) {
			r.advance(HOUR);
			await r.tick();
		}
		expect(r.t3.launched).toHaveLength(2);
	});
});

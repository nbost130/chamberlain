/**
 * The launch rule, as one rule in one place: at most ONE launch call per tick, a pending or open reservation starts the cooldown from its creation
 * (and from each launch call) and blocks a new reservation, and a retry reuses its key. A property-style test drives random sequences of ticks,
 * restarts, T3 errors and clock moves (backwards, never forwards) against it.
 */
import { describe, expect, test } from "bun:test";
import { HOUR, NOW } from "../../testing/overhead-fixtures.ts";
import { crossing, heldOf, inv, rig, stateOf } from "../../testing/overhead-tick-rig.ts";
import { closeInvestigation, recordOpened } from "./trigger.ts";

const two = () => crossing({ checkEveryHours: 1, investigator: { ...inv, maxOpen: 2, cooldownHours: 1 } });
const lastLog = (r: ReturnType<typeof rig>) => r.logs.at(-1)?.fields;

describe("a delayed retry and a new reservation never start two threads close together", () => {
	test("the retry that makes the thread is the tick's one launch; a new reservation waits out the cooldown from that call", async () => {
		const r = rig({ cfg: two() });
		r.t3.failLaunch = true; // the first launch never reaches T3: reserved, no thread, outcome unknown
		await r.tick();
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(r.t3.created.size).toBe(0);

		r.t3.failLaunch = false;
		r.advance(3 * HOUR); // the reservation is long past the cooldown, and maxOpen 2 has room
		const before = r.t3.launched.length;
		await r.tick();
		expect(r.t3.launched.length - before).toBe(1);
		expect(r.t3.created.size).toBe(1);
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(stateOf(r).investigations[0]).toMatchObject({ status: "open" });
		expect(lastLog(r)).toMatchObject({ opened: false, skipped: "cooldown" });

		r.advance(10 * 60_000);
		await r.tick();
		expect(r.t3.created.size).toBe(1); // still inside the cooldown counted from the retry

		r.advance(HOUR);
		await r.tick();
		expect(r.t3.created.size).toBe(2); // maxOpen 2 allows it once the cooldown is over
		const [a, b] = [...r.t3.created.values()];
		expect((b as number) - (a as number)).toBeGreaterThanOrEqual(HOUR);
	});

	test("two pending reservations (an old record) get one launch call per tick, not two", async () => {
		const r = rig({ cfg: two() });
		for (const id of ["OV-a", "OV-b"])
			recordOpened(r.store, {
				id,
				openedAt: NOW - 5 * HOUR,
				status: "pending",
				title: `Overhead investigation ${id}`,
				brief: `brief ${id}`,
				crossings: [],
			});
		await r.tick();
		expect(r.t3.launched.map((l) => l.seed)).toEqual(["OV-a"]);
		r.advance(6 * 60_000);
		await r.tick();
		expect(r.t3.launched.map((l) => l.seed)).toEqual(["OV-a", "OV-b"]);
		expect(heldOf(r).map((i) => i.status)).toEqual(["open", "open"]);
	});

	test("a pending reservation blocks a new one: maxOpen 2 with room does not let a second be reserved", async () => {
		const r = rig({ cfg: two() });
		r.t3.failLaunch = true;
		await r.tick();
		r.advance(3 * HOUR);
		await r.tick(); // the retry fails too: still pending
		expect(stateOf(r).investigations).toHaveLength(1);
		expect(lastLog(r)).toMatchObject({ skipped: "open-investigation" });
	});

	test("a retry reuses its key and never makes another reservation", async () => {
		const r = rig({ cfg: two() });
		r.t3.failLaunch = true;
		await r.tick();
		for (let i = 0; i < 4; i++) {
			r.advance(10 * 60_000);
			await r.tick();
		}
		expect(r.t3.launched.length).toBeGreaterThanOrEqual(3);
		expect(new Set(r.t3.launched.map((l) => l.seed)).size).toBe(1);
		expect(stateOf(r).investigations).toHaveLength(1);
	});
});

/** A small seeded generator, so a failing sequence can be replayed. */
function prng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const STEPS = [60_000, 240_000, 360_000, 1_200_000, 4_200_000, 10_800_000];

async function drive(seed: number, maxOpen: number) {
	const rnd = prng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
	const r = rig({ cfg: crossing({ checkEveryHours: 1, investigator: { ...inv, maxOpen, cooldownHours: 1 } }) });
	const ids = new Set<string>();
	for (let n = 0; n < 120; n++) {
		const x = rnd();
		const where = `seed ${seed}, maxOpen ${maxOpen}, op ${n}`;
		if (x < 0.4) {
			const before = r.t3.launched.length;
			await r.tick();
			expect(r.t3.launched.length - before, `${where}: launch calls in one tick`).toBeLessThanOrEqual(1);
		} else if (x < 0.65) r.advance(pick(STEPS));
		else if (x < 0.75) r.restart();
		else if (x < 0.85) {
			r.t3.failLaunch = rnd() < 0.4;
			r.t3.loseResponse = rnd() < 0.3;
			r.t3.loseBrief = rnd() < 0.2;
			r.t3.refuse = rnd() < 0.2;
			r.t3.inspectFails = rnd() < 0.2;
		} else if (x < 0.9)
			r.jump(-pick(STEPS)); // the wall clock goes backwards; it never jumps forward
		else if (x < 0.96) {
			const held = heldOf(r);
			if (held.length) closeInvestigation(r.store, pick(held).id, { by: "investigator", now: r.at() });
		} else {
			const t = r.t3.threads.get(pick([...r.t3.threads.keys(), "none"]));
			if (t) t.active = false;
		}
		for (const i of stateOf(r).investigations) ids.add(i.id);
		expect(heldOf(r).length, `${where}: held reservations`).toBeLessThanOrEqual(maxOpen);
		const made = [...r.t3.created.values()].sort((a, b) => a - b);
		for (let k = 1; k < made.length; k++)
			expect((made[k] as number) - (made[k - 1] as number), `${where}: threads made too close`).toBeGreaterThanOrEqual(
				HOUR,
			);
		for (const l of r.t3.launched) expect(ids.has(l.seed), `${where}: a launch under an unreserved key`).toBe(true);
	}
	return r.t3.created.size;
}

describe("property: random ticks, restarts, T3 errors and backwards clock moves", () => {
	test("no two threads within one cooldown, never more than maxOpen held, one launch call per tick, only reserved keys", async () => {
		let made = 0;
		for (let seed = 1; seed <= 30; seed++) for (const maxOpen of [1, 2]) made += await drive(seed, maxOpen);
		expect(made).toBeGreaterThan(30); // the sequences do launch, so the invariants were tested on something
	});
});

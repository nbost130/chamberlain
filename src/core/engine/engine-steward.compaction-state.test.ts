/**
 * The compaction record is durable (a restart does not reset the cooldown), and a compaction that did not bring the context under the line is
 * not repeated every cooldown: the Steward is handed off instead (audit round 1, finding 4).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
import { type Health, readHealth } from "../steward/steward-health.ts";
import { healthTicker } from "../steward/steward-health-ticker.ts";
import { type CompactState, createStewardCheck } from "./engine-steward.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const MIN = 60_000;
const LINE = 130_000;

/** A steward check over a compaction record that outlives it: a new `check()` over the same `box` is a restarted daemon. */
function world(box: { state?: CompactState }, used: number | undefined) {
	const calls: [string, ...unknown[]][] = [];
	const probe: { p: StewardProbe } = { p: { readable: true, ...(used !== undefined ? { contextTokens: used } : {}) } };
	const check = createStewardCheck({
		privateFile: (n) => (n === "steward-thread" ? "th-steward" : undefined),
		exclude: new Set(),
		probe: () => probe.p,
		rightsSent: { get: () => undefined, set: () => {}, epoch: () => 0 },
		compactReady: () => true,
		compact: async (id) => {
			calls.push(["compact", id]);
			return { ok: true, status: 202 };
		},
		log: (event, data) => calls.push(["log", event, data]),
		alarm: () => {},
		raiseAlarm: () => {},
		dry: false,
		compactAt: LINE,
		compactState: {
			get: () => box.state,
			set: (s) => {
				box.state = s;
			},
		},
		onDecisionsThread: () => {},
	}).check;
	const compacts = () => calls.filter((c) => c[0] === "compact").length;
	const at = (ms: number, u: number) => {
		setSystemTime(new Date(ms));
		probe.p = { readable: true, contextTokens: u };
	};
	return { check, calls, compacts, at };
}

afterEach(() => setSystemTime());

describe("the cooldown is durable", () => {
	test("must not compact again after a restart inside the cooldown", async () => {
		setSystemTime(new Date(NOW));
		const box: { state?: CompactState } = {
			state: { thread: "th-steward", at: NOW - 5 * MIN, used: 131_000, cleared: false },
		};
		const restarted = world(box, 140_000);
		await restarted.check();
		expect(restarted.compacts()).toBe(0);
	});

	test("the compaction is recorded when it fires, for this Steward thread", async () => {
		const box: { state?: CompactState } = {};
		const w = world(box, 131_000);
		w.at(NOW, 131_000);
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state).toEqual({ thread: "th-steward", at: NOW, used: 131_000, cleared: false });
	});

	test("must still compact: a record for another Steward thread is not this one's cooldown", async () => {
		const box: { state?: CompactState } = {
			state: { thread: "an-older-steward", at: NOW - MIN, used: 999, cleared: false },
		};
		const w = world(box, 140_000);
		w.at(NOW, 140_000);
		await w.check();
		expect(w.compacts()).toBe(1);
	});
});

describe("a compaction that does not get the context under the line", () => {
	test("must not compact again: it escalates once, and logs it", async () => {
		const box: { state?: CompactState } = {
			state: { thread: "th-steward", at: NOW - 11 * MIN, used: 131_000, cleared: false },
		};
		const w = world(box, 140_000);
		w.at(NOW, 140_000);
		await w.check();
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBe(true);
		expect(w.calls.filter((c) => c[1] === "compact-ineffective")).toEqual([
			["log", "compact-ineffective", { threadId: "th-steward", used: 140_000, was: 131_000 }],
		]);
	});

	test("must compact again once one worked: the context was seen under the line since, and has grown past it", async () => {
		const box: { state?: CompactState } = {
			state: { thread: "th-steward", at: NOW - 30 * MIN, used: 131_000, cleared: false },
		};
		const w = world(box, 90_000);
		w.at(NOW - 20 * MIN, 90_000);
		await w.check();
		expect(box.state?.cleared).toBe(true);
		w.at(NOW, 135_000);
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state).toMatchObject({ at: NOW, cleared: false });
	});
});

describe("the health check says HAND OFF for a failed compaction", () => {
	const compacting = (): Health => ({
		at: new Date(NOW).toISOString(),
		verdict: "COMPACT",
		session: "s1",
		thread: "th-steward",
		replies: 0,
		breaks: 0,
		selfReads: 0,
		threadRereads: 0,
		elevated: ["context"],
		unknown: [],
		report: "",
	});
	const run = async (failed: boolean) => {
		const store = memStore();
		const handoffs: string[] = [];
		await healthTicker({
			store,
			collect: async () => compacting(),
			compactFailed: () => failed,
			handoff: (h, s) => handoffs.push(`${h.verdict}:${s}`),
			now: () => NOW,
		})();
		return { handoffs, health: readHealth(store) };
	};

	test("must hand off: a compaction that did not work escalates the verdict and starts the hand-off", async () => {
		const { handoffs, health } = await run(true);
		expect(handoffs).toEqual(["HAND OFF:s1"]);
		expect(health?.elevated).toContain("compaction");
		expect(health?.report).toContain("did not bring the context under the compaction line");
	});

	test("must not hand off: with no failed compaction a context over the line is only COMPACT", async () => {
		const { handoffs, health } = await run(false);
		expect(handoffs).toEqual([]);
		expect(health?.verdict).toBe("COMPACT");
	});
});

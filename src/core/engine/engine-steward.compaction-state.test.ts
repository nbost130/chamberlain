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

/** What the daemon asks T3 for, and how T3 answers. */
type Opts = { compact?: () => Promise<{ ok: boolean; status?: number }>; ready?: boolean; dry?: boolean };

/** A steward check over a compaction record that outlives it: a new `check()` over the same `box` is a restarted daemon. */
function world(box: { state?: CompactState }, o: Opts = {}) {
	const calls: [string, ...unknown[]][] = [];
	const probe: { p: StewardProbe } = { p: { readable: true } };
	const check = createStewardCheck({
		privateFile: (n) => (n === "steward-thread" ? "th-steward" : undefined),
		exclude: new Set(),
		probe: () => probe.p,
		rightsSent: { get: () => undefined, set: () => {}, epoch: () => 0 },
		compactReady: () => o.ready ?? true,
		compact: async (id) => {
			calls.push(["compact", id]);
			return o.compact ? o.compact() : { ok: true, status: 202 };
		},
		log: (event, data) => calls.push(["log", event, data]),
		alarm: () => {},
		raiseAlarm: () => {},
		dry: o.dry ?? false,
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
	/** The time, and what T3 shows of the Steward then. */
	const at = (ms: number, p: Partial<StewardProbe>) => {
		setSystemTime(new Date(ms));
		probe.p = { readable: true, ...p };
	};
	return { check, calls, compacts, at };
}

/** An accepted compaction record, sent `ago` minutes before NOW with 4 compactions completed then. */
const sent = (ago: number, over: Partial<CompactState> = {}): CompactState => ({
	thread: "th-steward",
	at: NOW - ago * MIN,
	used: 131_000,
	cleared: false,
	compactions: 4,
	...over,
});

afterEach(() => setSystemTime());

describe("the cooldown is durable, and only an accepted compaction is recorded", () => {
	test("must not compact again after a restart inside the cooldown", async () => {
		const w = world({ state: sent(5) });
		w.at(NOW, { contextTokens: 140_000, compactions: 4 });
		await w.check();
		expect(w.compacts()).toBe(0);
	});

	test("recorded once T3 accepted it, for this Steward thread, with the compaction count then", async () => {
		const box: { state?: CompactState } = {};
		const w = world(box);
		w.at(NOW, { contextTokens: 131_000, compactions: 4 });
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state).toEqual({ thread: "th-steward", at: NOW, used: 131_000, cleared: false, compactions: 4 });
	});

	test("must not record a refused POST, or a thrown one: it retries on the next tick after the normal cooldown, never as a failed compaction", async () => {
		for (const compact of [
			async () => ({ ok: false, status: 503 }),
			async (): Promise<{ ok: boolean }> => {
				throw new Error("connection reset");
			},
		]) {
			const box: { state?: CompactState } = {};
			const w = world(box, { compact });
			w.at(NOW, { contextTokens: 131_000, compactions: 4 });
			await w.check();
			expect(box.state).toBeUndefined();
			w.at(NOW + MIN, { contextTokens: 131_000, compactions: 4 });
			await w.check();
			expect(w.compacts()).toBe(1);
			w.at(NOW + 10 * MIN, { contextTokens: 131_000, compactions: 4 });
			await w.check();
			expect(w.compacts()).toBe(2);
			w.at(NOW + 21 * MIN, { contextTokens: 131_000, compactions: 4 });
			await w.check();
			expect(box.state).toBeUndefined();
			expect(w.calls.some((c) => c[1] === "compact-ineffective")).toBe(false);
		}
	});

	test("must not record when the Steward is not ready, or on a dry run", async () => {
		for (const o of [{ ready: false }, { dry: true }]) {
			const box: { state?: CompactState } = {};
			const w = world(box, o);
			w.at(NOW, { contextTokens: 140_000, compactions: 4 });
			await w.check();
			expect(box.state).toBeUndefined();
			expect(w.compacts()).toBe(0);
		}
	});

	test("must still compact: a record for another Steward thread is not this one's cooldown", async () => {
		const w = world({ state: { thread: "an-older-steward", at: NOW - MIN, used: 999, cleared: false } });
		w.at(NOW, { contextTokens: 140_000, compactions: 4 });
		await w.check();
		expect(w.compacts()).toBe(1);
	});
});

describe("a compaction is judged only once it has run", () => {
	const ran = { contextTokens: 140_000, compactions: 5, compactionTurn: 9, contextTurn: 9 };

	test("must not call it ineffective while it is still on its way: queued behind a long turn, or counted nowhere yet", async () => {
		const box: { state?: CompactState } = { state: sent(11) };
		const w = world(box);
		w.at(NOW, { contextTokens: 140_000, compactions: 4, contextTurn: 8 });
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBeUndefined();
		w.at(NOW, { contextTokens: 140_000, compactions: 4, compactBlocked: "one is already queued or running" });
		await w.check();
		expect(box.state?.failed).toBeUndefined();
		expect(w.calls.some((c) => c[1] === "compact-ineffective")).toBe(false);
	});

	test("must not call it ineffective on a measurement that predates its boundary, or while another is queued", async () => {
		const box: { state?: CompactState } = { state: sent(11) };
		const w = world(box);
		w.at(NOW, { ...ran, contextTurn: 8 });
		await w.check();
		w.at(NOW, { ...ran, compactBlocked: "one is already queued or running" });
		await w.check();
		expect(box.state?.failed).toBeUndefined();
		expect(w.compacts()).toBe(0);
	});

	test("must escalate, once, when it has run and the context is still over the line: no second compaction", async () => {
		const box: { state?: CompactState } = { state: sent(11) };
		const w = world(box);
		w.at(NOW, ran);
		await w.check();
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBe(true);
		expect(w.calls.filter((c) => c[1] === "compact-ineffective")).toEqual([
			["log", "compact-ineffective", { threadId: "th-steward", used: 140_000, was: 131_000 }],
		]);
	});

	test("the failed verdict ends once the context is back under the line", async () => {
		const box: { state?: CompactState } = { state: sent(11, { failed: true }) };
		const w = world(box);
		w.at(NOW, { ...ran, contextTokens: 90_000 });
		await w.check();
		expect(box.state?.failed).toBeUndefined();
		expect(box.state?.cleared).toBe(true);
	});

	test("must compact again once one worked: the context was seen under the line since, and has grown past it", async () => {
		const box: { state?: CompactState } = { state: sent(30) };
		const w = world(box);
		w.at(NOW - 20 * MIN, { contextTokens: 90_000, compactions: 5, compactionTurn: 9, contextTurn: 9 });
		await w.check();
		expect(box.state?.cleared).toBe(true);
		w.at(NOW, { contextTokens: 135_000, compactions: 5, compactionTurn: 9, contextTurn: 12 });
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state).toMatchObject({ at: NOW, cleared: false, compactions: 5 });
	});

	test("an accepted compaction that never ran and is not queued, half an hour on, is lost and is sent again", async () => {
		const w = world({ state: sent(31) });
		w.at(NOW, { contextTokens: 140_000, compactions: 4, contextTurn: 8 });
		await w.check();
		expect(w.compacts()).toBe(1);
	});

	test("a completed compaction with unknown context stays pending until a measured result", async () => {
		const box: { state?: CompactState } = { state: sent(31) };
		const w = world(box);
		const evidence = { retryLostCompact: false, compactions: 5, compactionTurn: 9, contextTurn: 9 };
		w.at(NOW, evidence);
		await w.check();
		expect(box.state?.failed).toBeUndefined();
		w.at(NOW + MIN, { ...evidence, contextTokens: 140_000 });
		await w.check();
		expect(box.state?.failed).toBe(true);
		expect(w.compacts()).toBe(0);
	});
});

describe("an unreadable compaction count is not a lost compaction (audit round 3, item 8)", () => {
	test("must not re-send: with the count unreadable, a compaction unseen after half an hour is judged by the context size, over the line is a failure, once", async () => {
		const box: { state?: CompactState } = { state: sent(31) };
		const w = world(box);
		w.at(NOW, { contextTokens: 140_000 });
		await w.check();
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBe(true);
		expect(w.calls.filter((c) => c[1] === "compact-ineffective")).toHaveLength(1);
	});

	test("must stay pending inside the half hour even with the count unreadable", async () => {
		const box: { state?: CompactState } = { state: sent(11) };
		const w = world(box);
		w.at(NOW, { contextTokens: 140_000 });
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBeUndefined();
	});

	test("a record that never had a count (written while it was unreadable) is judged the same way: never re-sent", async () => {
		const box: { state?: CompactState } = { state: sent(31, { compactions: undefined }) };
		const w = world(box);
		w.at(NOW, { contextTokens: 140_000, compactions: 4 });
		await w.check();
		expect(w.compacts()).toBe(0);
		expect(box.state?.failed).toBe(true);
	});

	test("with the count readable a lost compaction is sent again ONCE, and a second that never ran is a failure: never a third", async () => {
		const box: { state?: CompactState } = { state: sent(31) };
		const w = world(box);
		w.at(NOW, { contextTokens: 140_000, compactions: 4, contextTurn: 8 });
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state).toMatchObject({ at: NOW, resends: 1 });
		w.at(NOW + 31 * MIN, { contextTokens: 140_000, compactions: 4, contextTurn: 8 });
		await w.check();
		expect(w.compacts()).toBe(1);
		expect(box.state?.failed).toBe(true);
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

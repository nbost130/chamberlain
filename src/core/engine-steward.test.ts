import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { StewardProbe } from "./adapter.ts";
import type { RightsSent } from "./decide.ts";
import { createStewardCheck, type StewardCheckDeps } from "./engine-steward.ts";
import { alarms } from "./messages.ts";

const HASH = "a".repeat(64);
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const MIN = 60_000;

/** A steward check over fakes that record everything it is told, in order. */
function rig(over: Partial<StewardCheckDeps> = {}, o: { files?: Record<string, string>; sent?: RightsSent } = {}) {
	const calls: [string, ...unknown[]][] = [];
	let sent = o.sent;
	const files: Record<string, string> = {
		"steward-thread": "th-steward",
		"decisions-thread": "th-decisions",
		...o.files,
	};
	const state: { probe: StewardProbe | undefined } = { probe: { readable: true, contextTokens: 100 } };
	const deps: StewardCheckDeps = {
		privateFile: (name) => files[name],
		exclude: new Set<string>(),
		probe: () => state.probe,
		rightsSent: {
			get: () => sent,
			set: (next) => {
				calls.push(["rights-set", next]);
				sent = next;
			},
			epoch: () => 0,
		},
		compactReady: () => true,
		compact: async (deliveryId) => {
			calls.push(["compact", deliveryId]);
			return { status: 202 };
		},
		log: (event, data) => calls.push(["log", event, data]),
		alarm: (key, title, summary) => calls.push(["alarm", key, title, summary]),
		raiseAlarm: (key, a) => calls.push(["raise", key, a]),
		dry: false,
		compactAt: 1000,
		onDecisionsThread: (id) => calls.push(["decisions", id]),
		...over,
	};
	const check = createStewardCheck(deps);
	return { ...check, calls, state, deps, files };
}
const over = (n: number): StewardProbe => ({ readable: true, contextTokens: n });

afterEach(() => setSystemTime());

describe("the Steward check: who it looks at", () => {
	test("it tells the engine the Decisions thread first, and stops when the Steward has no thread", async () => {
		const r = rig({}, { files: { "steward-thread": "" } });
		await r.check();
		expect(r.calls).toEqual([["decisions", "th-decisions"]]);
		expect(r.deps.exclude.size).toBe(0);
		const none = rig();
		delete none.files["decisions-thread"];
		delete none.files["steward-thread"];
		await none.check();
		expect(none.calls).toEqual([["decisions", undefined]]);
	});
	test("the Steward's own thread joins the threads the engine never wakes about, and with no probe nothing else happens", async () => {
		const r = rig();
		r.state.probe = undefined;
		await r.check();
		expect([...r.deps.exclude]).toEqual(["th-steward"]);
		expect(r.calls).toEqual([["decisions", "th-decisions"]]);
	});
});

describe("the Steward check: the rights high-water mark", () => {
	test("a record is raised to the context's size, every minute", async () => {
		const r = rig({}, { sent: { hash: HASH, used: 50 } });
		await r.check();
		expect(r.calls).toEqual([
			["decisions", "th-decisions"],
			["rights-set", { hash: HASH, used: 100 }],
		]);
	});
	test("a context that shrank, or whose size is unknown, drops the record and logs why", async () => {
		const shrunk = rig({}, { sent: { hash: HASH, used: 500 } });
		await shrunk.check();
		expect(shrunk.calls.slice(1)).toEqual([
			["rights-set", undefined],
			["log", "rights-invalidated", { reason: "context shrink", used: 100 }],
		]);
		const unknown = rig({}, { sent: { hash: HASH, used: 500 } });
		unknown.state.probe = { readable: true };
		await unknown.check();
		expect(unknown.calls.slice(1)).toEqual([
			["rights-set", undefined],
			["log", "rights-invalidated", { reason: "context shrink", used: undefined }],
		]);
	});
	test("with no record there is nothing to raise or drop", async () => {
		const r = rig();
		await r.check();
		expect(r.calls).toEqual([["decisions", "th-decisions"]]);
	});
});

describe("the Steward check: the alarms", () => {
	test("a run of five unreadable queue reads raises the alarm each minute after; one good read starts the count again", async () => {
		const r = rig();
		r.state.probe = { readable: false, contextTokens: 100 };
		for (let i = 0; i < 4; i++) await r.check();
		expect(r.calls.filter((c) => c[0] === "raise")).toEqual([]);
		await r.check();
		await r.check();
		expect(r.calls.filter((c) => c[0] === "raise")).toEqual([
			["raise", "steward-queue-unreadable", alarms.queueUnreadable(5)],
			["raise", "steward-queue-unreadable", alarms.queueUnreadable(6)],
		]);
		r.state.probe = over(100);
		await r.check();
		r.state.probe = { readable: false, contextTokens: 100 };
		for (let i = 0; i < 4; i++) await r.check();
		expect(r.calls.filter((c) => c[0] === "raise")).toHaveLength(2);
	});
	test("a stalled Steward raises its own alarm, with the probe's title and summary", async () => {
		const r = rig();
		r.state.probe = { readable: true, contextTokens: 100, stalled: { title: "stuck", summary: "no movement" } };
		await r.check();
		expect(r.calls).toEqual([
			["decisions", "th-decisions"],
			["alarm", "steward-stalled", "stuck", "no movement"],
		]);
	});
});

describe("the Steward check: compaction", () => {
	test("a context at or under the limit is left alone", async () => {
		const r = rig();
		r.state.probe = over(1000);
		await r.check();
		r.state.probe = { readable: true };
		await r.check();
		expect(r.calls.filter((c) => c[0] === "log" || c[0] === "compact")).toEqual([]);
	});
	test("past the limit it fires: logs, asks the relay to compact under a delivery id, logs the delivery with its status", async () => {
		setSystemTime(new Date(NOW));
		const r = rig();
		r.state.probe = over(2000);
		await r.check();
		const id = `compact:th-steward:${NOW}`;
		expect(r.calls.slice(1)).toEqual([
			["log", "fire", { server: "steward", kind: "compact", threadId: "th-steward", used: 2000 }],
			["compact", id],
			["log", "delivered", { deliveryId: id, http: 202, attempt: 1 }],
		]);
	});
	test("a delivery with no status logs none; a failure logs its message, or the thrown value as text", async () => {
		setSystemTime(new Date(NOW));
		const quiet = rig({ compact: async () => ({}) });
		quiet.state.probe = over(2000);
		await quiet.check();
		expect(quiet.calls.at(-1)).toEqual(["log", "delivered", { deliveryId: `compact:th-steward:${NOW}`, attempt: 1 }]);
		for (const [thrown, text] of [
			[Error("relay down"), "relay down"],
			["plain", "plain"],
		] as const) {
			const bad = rig({
				compact: async () => {
					throw thrown;
				},
			});
			bad.state.probe = over(2000);
			await bad.check();
			expect(bad.calls.at(-1)).toEqual([
				"log",
				"deliver-error",
				{ deliveryId: `compact:th-steward:${NOW}`, attempt: 1, error: text },
			]);
		}
	});
	test("a dry run logs the fire and sends nothing", async () => {
		const r = rig({ dry: true });
		r.state.probe = over(2000);
		await r.check();
		expect(r.calls.map((c) => (c[0] === "log" ? c[1] : c[0]))).toEqual(["decisions", "fire"]);
	});
	test("with no compaction target it raises the alarm instead, and sends nothing", async () => {
		const r = rig({ compactReady: () => false });
		r.state.probe = over(2000);
		await r.check();
		expect(r.calls.slice(1)).toEqual([["raise", "steward-compact", alarms.compactUnavailable(2000)]]);
	});
	test("a compaction is not sent again inside ten minutes, and is again after", async () => {
		setSystemTime(new Date(NOW));
		const r = rig();
		r.state.probe = over(2000);
		await r.check();
		setSystemTime(new Date(NOW + 10 * MIN - 1));
		await r.check();
		expect(r.calls.filter((c) => c[0] === "compact")).toHaveLength(1);
		setSystemTime(new Date(NOW + 10 * MIN));
		await r.check();
		expect(r.calls.filter((c) => c[0] === "compact")).toHaveLength(2);
	});
	test("a compaction the backend says must wait is logged once per reason, the clearing is logged, and nothing is sent meanwhile", async () => {
		setSystemTime(new Date(NOW));
		const r = rig();
		const at = (m: number) => setSystemTime(new Date(NOW + m * MIN));
		r.state.probe = { ...over(2000), compactBlocked: "a run is active" };
		await r.check();
		at(11);
		await r.check();
		r.state.probe = { ...over(2000), compactBlocked: "a different reason" };
		at(22);
		await r.check();
		r.state.probe = over(2000);
		at(33);
		await r.check();
		expect(r.calls.filter((c) => c[0] === "log").map((c) => [c[1], c[2]])).toEqual([
			["skip-compact", { reason: "a run is active" }],
			["skip-compact", { reason: "a different reason" }],
			["compact-clear", { reason: undefined }],
			["fire", { server: "steward", kind: "compact", threadId: "th-steward", used: 2000 }],
			["delivered", { deliveryId: `compact:th-steward:${NOW + 33 * MIN}`, http: 202, attempt: 1 }],
		]);
		expect(r.calls.filter((c) => c[0] === "compact")).toHaveLength(1);
	});
});

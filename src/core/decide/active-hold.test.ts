/** Active hold, the pure parts: the due time, the verdict on a held card, the note's place in the wake, and the config's validation. */
import { describe, expect, test } from "bun:test";
import { normalizeThread, type ThreadInput, type ThreadState } from "../adapter/adapter.ts";
import type { WaitingRead } from "../adapter/adapter-waiting.ts";
import { DEFAULT_ACTIVE_HOLD, parseActiveHold } from "../config/active-hold-config.ts";
import { ConfigFileError, parseConfigDoc } from "../config/layout-schema.ts";
import { holdUntil, releaseVerdict, withNote } from "./active-hold.ts";

const MIN = 60_000;
const NOW = 1_000_000_000_000;

describe("holdUntil", () => {
	test("is the principal's last message plus the window", () => {
		expect(holdUntil(NOW - 2 * MIN, NOW, 5 * MIN)).toBe(NOW + 3 * MIN);
	});
	test("is nothing when no message was seen, or the window has ended", () => {
		expect(holdUntil(undefined, NOW, 5 * MIN)).toBeUndefined();
		expect(holdUntil(NOW - 5 * MIN, NOW, 5 * MIN)).toBeUndefined();
		expect(holdUntil(NOW - 9 * MIN, NOW, 5 * MIN)).toBeUndefined();
	});
	test("a message stamped in the future holds one window from now, never longer", () => {
		expect(holdUntil(NOW + 60 * MIN, NOW, 5 * MIN)).toBe(NOW + 5 * MIN);
	});
	test("a window that is not a real number holds nothing, never a due time that is not one", () => {
		expect(holdUntil(NOW, NOW, Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(holdUntil(NOW, NOW, 1e308 * 60_000)).toBeUndefined();
		expect(holdUntil(Number.POSITIVE_INFINITY, NOW, 5 * MIN)).toBeUndefined();
	});
	test("a zero window holds nothing", () => {
		expect(holdUntil(NOW, NOW, 0)).toBeUndefined();
	});
});

const live = (over: Partial<ThreadInput> = {}): ThreadState =>
	normalizeThread({ id: "t1", title: "T", status: "waiting", pendingRequestId: "r1", ...over });
const card = (requestId: string) => ({ type: "user_input_request" as const, requestId, label: "L", questions: [] });
const read = (...ids: string[]): WaitingRead => ({ ok: true, cards: ids.map(card), resolved: [] });
/** A read that shows these cards resolved (each with its own terminal item). */
const resolved = (...ids: string[]): WaitingRead => ({ ok: true, cards: [], resolved: ids });

describe("releaseVerdict", () => {
	const p = { requestIds: ["r1"] };
	test("still waiting on its card: wake", () => {
		expect(releaseVerdict(p, live(), read("r1"))).toEqual({ act: "wake" });
	});
	test("its card shown resolved by its own terminal item: dropped as answered", () => {
		expect(releaseVerdict(p, live(), resolved("r1"))).toEqual({ act: "drop", reason: "answered" });
	});
	test("absence is not evidence: a card missing from a bounded read, resolved or waiting nowhere, wakes", () => {
		expect(releaseVerdict(p, live(), read())).toEqual({ act: "wake" });
		expect(releaseVerdict(p, live(), read("r2"))).toEqual({ act: "wake" });
		expect(releaseVerdict(p, live(), { ok: true, cards: [] })).toEqual({ act: "wake" });
		expect(releaseVerdict(p, live(), resolved("r2"))).toEqual({ act: "wake" });
	});
	test("several cards: dropped only when every one is resolved", () => {
		const two = { requestIds: ["r1", "r2"] };
		expect(releaseVerdict(two, live(), resolved("r1", "r2"))).toEqual({ act: "drop", reason: "answered" });
		expect(releaseVerdict(two, live(), resolved("r1"))).toEqual({ act: "wake" });
	});
	test("an archived, settled or snoozed thread: dropped as left", () => {
		for (const over of [{ archived: true }, { settled: true }, { snoozed: true }])
			expect(releaseVerdict(p, live(over), read("r1"))).toEqual({ act: "drop", reason: "left" });
	});
	test("no evidence is never a drop: a failed read, no read, or a thread the engine does not know wakes", () => {
		expect(releaseVerdict(p, live(), { ok: false, reason: "down" })).toEqual({ act: "wake" });
		expect(releaseVerdict(p, live(), undefined)).toEqual({ act: "wake" });
		expect(releaseVerdict(p, undefined, read())).toEqual({ act: "wake" });
	});
	test("a wake raised with no card ids follows the thread: waiting wakes, not waiting is dropped", () => {
		expect(releaseVerdict({ requestIds: [] }, live(), read())).toEqual({ act: "wake" });
		expect(releaseVerdict({ requestIds: [] }, live({ status: "running", pendingRequestId: null }), read())).toEqual({
			act: "drop",
			reason: "answered",
		});
	});
});

describe("withNote", () => {
	test("puts the note on the second line, after the head the Steward reads first", () => {
		expect(withNote("HEAD\nbody\nmore", "NOTE")).toBe("HEAD\nNOTE\nbody\nmore");
	});
	test("a one-line wake gets the note after it", () => {
		expect(withNote("HEAD", "NOTE")).toBe("HEAD\nNOTE");
	});
});

describe("activeHold config", () => {
	test("absent or null is on, with a five-minute window", () => {
		expect(parseActiveHold(undefined)).toEqual(DEFAULT_ACTIVE_HOLD);
		expect(parseActiveHold(null)).toEqual({ enabled: true, windowMs: 5 * MIN });
		expect(parseActiveHold({})).toEqual({ enabled: true, windowMs: 5 * MIN });
	});
	test("enabled and windowMinutes are read", () => {
		expect(parseActiveHold({ enabled: false })).toEqual({ enabled: false, windowMs: 5 * MIN });
		expect(parseActiveHold({ windowMinutes: 2 })).toEqual({ enabled: true, windowMs: 120_000 });
		expect(parseActiveHold({ windowMinutes: 60 })).toEqual({ enabled: true, windowMs: 60 * MIN });
		expect(parseActiveHold({ windowMinutes: 1 })).toEqual({ enabled: true, windowMs: MIN });
	});
	test("a bad value is refused, naming the key", () => {
		expect(() => parseActiveHold({ enabled: "yes" })).toThrow("activeHold.enabled");
		for (const windowMinutes of [0, -1, 0.5, 2.5, 61, 1e308, "5", Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => parseActiveHold({ windowMinutes })).toThrow("activeHold.windowMinutes");
		expect(() => parseActiveHold({ windowMinute: 5 })).toThrow("activeHold.windowMinute");
		expect(() => parseActiveHold([])).toThrow("activeHold");
	});
	test("config.json checks the section at load: a good one passes, a bad one is a ConfigFileError", () => {
		expect(() => parseConfigDoc({ activeHold: { enabled: true, windowMinutes: 10 } })).not.toThrow();
		expect(() => parseConfigDoc({ activeHold: null })).not.toThrow();
		expect(() => parseConfigDoc({ activeHold: { windowMinutes: 0 } })).toThrow(ConfigFileError);
		expect(() => parseConfigDoc({ activeHold: { enabled: 1 } })).toThrow(ConfigFileError);
		expect(() => parseConfigDoc({ activeHold: [] })).toThrow(ConfigFileError);
	});
});

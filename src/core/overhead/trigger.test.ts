import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, NOW } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import type { Crossing } from "./metrics.ts";
import {
	closeInvestigation,
	decide,
	heldNotes,
	type Investigation,
	isHeld,
	type OverheadState,
	readOverheadState,
	recordOpened,
	staleOf,
	updateInvestigation,
	wallElapsed,
} from "./trigger.ts";

const crossed: Crossing[] = [{ metric: "noopRate", value: 0.3, threshold: 0.1, detail: "no-op wake rate 30%" }];
const investigator = {
	enabled: true,
	model: { adapter: "t3", server: "s", instanceId: "p", model: "m", options: {} },
	projectId: "proj",
};
const cfg = (inv: Record<string, unknown> = {}) =>
	cfgWith({ enabled: true, investigator: { ...investigator, ...inv } });
const inv = (id: string, hoursAgo: number, o: Partial<Investigation> = {}): Investigation => ({
	id,
	openedAt: NOW - hoursAgo * HOUR,
	status: "open",
	crossings: [],
	...o,
});
const closed = (id: string, hoursAgo: number, by: Investigation["closedBy"] = "investigator") =>
	inv(id, hoursAgo, { status: "closed", closedBy: by, closedAt: NOW - HOUR });
const state = (...investigations: Investigation[]): OverheadState => ({ investigations });
const decision = (s: OverheadState, c = cfg(), crossings = crossed, elapsed = wallElapsed(NOW)) =>
	decide({ crossings, state: s, elapsed, cfg: c });

describe("opening an investigation", () => {
	test("a crossing with nothing held and nothing recent opens one", () => {
		expect(decision(state())).toEqual({ open: true });
	});

	test("no crossing opens nothing", () => {
		expect(decision(state(), cfg(), [])).toMatchObject({ open: false, reason: "no-crossing" });
	});

	test("the monitor or the investigator being off opens nothing, whatever crossed", () => {
		expect(decision(state(), cfgWith({ investigator }))).toMatchObject({ open: false, reason: "disabled" });
		expect(decision(state(), cfgWith({ enabled: true }))).toMatchObject({ open: false, reason: "disabled" });
	});
});

describe("the cooldown", () => {
	test("one investigation per cooldown: a crossing inside it is suppressed, with the time in the reason", () => {
		const d = decision(state(closed("OV-a", 5)));
		expect(d).toMatchObject({ open: false, reason: "cooldown" });
		expect(d.open === false && d.detail).toContain("OV-a launched 300 min ago");
	});

	test("it counts from the later of the reservation and its last launch call: a retry 2 h ago restarts it", () => {
		const retried = inv("OV-a", 30, { status: "closed", closedBy: "investigator", launchedAt: NOW - 2 * HOUR });
		expect(decision(state(retried))).toMatchObject({ open: false, reason: "cooldown" });
		const long = inv("OV-a", 30, { status: "closed", closedBy: "investigator", launchedAt: NOW - 25 * HOUR });
		expect(decision(state(long))).toEqual({ open: true });
	});

	test("it counts from the newest of every reservation's launch, not the last one in the list", () => {
		const older = inv("OV-a", 40, { status: "closed", closedBy: "investigator", launchedAt: NOW - HOUR });
		const newer = inv("OV-b", 30, { status: "closed", closedBy: "investigator" });
		expect(decision(state(older, newer))).toMatchObject({ open: false, reason: "cooldown" });
	});

	test("it counts from when the last one was RESERVED, and ends exactly at the cooldown", () => {
		expect(decision(state(closed("OV-a", 23.9)))).toMatchObject({ open: false, reason: "cooldown" });
		expect(decision(state(closed("OV-a", 24)))).toEqual({ open: true });
		expect(decision(state(closed("OV-a", 80)))).toEqual({ open: true });
	});

	test("a pending reservation blocks a new one whatever maxOpen is, old or new", () => {
		for (const hours of [1, 30]) {
			expect(decision(state(inv("OV-a", hours, { status: "pending" })), cfg({ maxOpen: 5 }))).toMatchObject({
				open: false,
				reason: "open-investigation",
			});
		}
	});

	test("an open reservation inside the cooldown holds it, whatever maxOpen is", () => {
		expect(decision(state(inv("OV-a", 1, { status: "open" })), cfg({ maxOpen: 5 }))).toMatchObject({
			open: false,
			reason: "cooldown",
		});
	});

	test("the cooldown is the operator's", () => {
		const s = state(closed("OV-a", 30));
		expect(decision(s, cfg({ cooldownHours: 48 }))).toMatchObject({ open: false, reason: "cooldown" });
		expect(decision(s, cfg({ cooldownHours: 0 }))).toEqual({ open: true });
	});

	test("a launch that failed before anything was sent holds neither the cooldown nor the slot", () => {
		expect(decision(state(closed("OV-a", 1, "launch-failed")))).toEqual({ open: true });
	});

	test("a clock that went backwards is no time at all, never a negative one", () => {
		const reserved = inv("OV-a", -5, { status: "closed", closedBy: "investigator" }); // reserved 5 h in the future
		expect(wallElapsed(NOW)(reserved)).toBe(0);
		expect(decision(state(reserved))).toMatchObject({ open: false, reason: "cooldown" });
	});

	test("a clock that jumped forward cannot shorten it when the monotonic clock disagrees", () => {
		const s = state(closed("OV-a", 40)); // by the wall clock, 40 h ago
		expect(decision(s)).toEqual({ open: true });
		const monotonic = (i: Investigation) => Math.min(wallElapsed(NOW)(i), 2 * HOUR);
		expect(decision(s, cfg(), crossed, monotonic)).toMatchObject({ open: false, reason: "cooldown" });
	});
});

describe("held reservations", () => {
	test("a pending or an open one suppresses another, even past the cooldown", () => {
		for (const status of ["pending", "open"] as const) {
			const d = decision(state(inv("OV-a", 30, { status })));
			expect(d).toMatchObject({ open: false, reason: "open-investigation" });
			expect(d.open === false && d.detail).toContain(
				status === "pending" ? "OV-a pending (launch outcome unknown)" : "OV-a (open) held (at most 1)",
			);
		}
	});

	test("maxOpen allows that many held at once, and not one more", () => {
		const two = cfg({ maxOpen: 2, cooldownHours: 0 });
		expect(decision(state(inv("OV-a", 30)), two)).toEqual({ open: true });
		expect(decision(state(inv("OV-a", 30), inv("OV-b", 31, { status: "pending" })), two)).toMatchObject({
			open: false,
			reason: "open-investigation",
		});
	});

	test("age alone never releases one: past the TTL it is still held, and only stale", () => {
		const old = state(inv("OV-a", 80));
		expect(decision(old)).toMatchObject({ open: false, reason: "open-investigation" });
		expect(staleOf(old, wallElapsed(NOW), cfg()).map((i) => i.id)).toEqual(["OV-a"]);
		expect(staleOf(state(inv("OV-a", 71)), wallElapsed(NOW), cfg())).toEqual([]);
	});

	test("a forward jump of thirty days frees nothing", () => {
		const s = state(inv("OV-a", 1));
		expect(
			decide({ crossings: crossed, state: s, elapsed: wallElapsed(NOW + 30 * 24 * HOUR), cfg: cfg() }),
		).toMatchObject({
			open: false,
			reason: "open-investigation",
		});
	});

	test("stale and unconfirmed ones are reported as such", () => {
		const s = state(inv("OV-a", 80), inv("OV-b", 3, { status: "pending" }), closed("OV-c", 90));
		const notes = heldNotes(s, wallElapsed(NOW), cfg());
		expect(notes).toHaveLength(2);
		expect(notes[0]).toContain("OV-a is stale: held 80 h, past 72 h");
		expect(notes[1]).toContain("OV-b: launch outcome not confirmed (3 h)");
	});
});

describe("the record", () => {
	test("is kept in the state and survives a re-read", () => {
		const store = memStore();
		recordOpened(store, inv("OV-a", 1, { status: "pending", title: "t", brief: "b" }));
		expect(readOverheadState(store).investigations[0]).toMatchObject({ id: "OV-a", status: "pending", brief: "b" });
	});

	test("retention caps the closed history and never evicts a pending or open reservation", () => {
		const store = memStore();
		recordOpened(store, inv("LIVE-1", 100));
		recordOpened(store, inv("LIVE-2", 99, { status: "pending" }));
		for (let i = 0; i < 40; i++) recordOpened(store, closed(`FAIL-${i}`, 50 - i, "launch-failed"));
		const list = readOverheadState(store).investigations;
		expect(list.filter(isHeld).map((i) => i.id)).toEqual(["LIVE-1", "LIVE-2"]);
		expect(list.filter((i) => !isHeld(i))).toHaveLength(20);
		expect(list.find((i) => i.id === "FAIL-39")).toBeDefined();
		expect(list.find((i) => i.id === "FAIL-0")).toBeUndefined();
	});

	test("closing a live one by update does not drop it either, and the held ones still block", () => {
		const store = memStore();
		for (let i = 0; i < 25; i++) recordOpened(store, closed(`OLD-${i}`, 200 - i));
		recordOpened(store, inv("LIVE", 5));
		recordOpened(store, inv("LIVE-B", 4, { status: "pending" }));
		const list = readOverheadState(store).investigations;
		expect(list.filter(isHeld)).toHaveLength(2);
		const d = decide({
			crossings: crossed,
			state: readOverheadState(store),
			elapsed: wallElapsed(NOW),
			cfg: cfg({ maxOpen: 2 }),
		});
		expect(d).toMatchObject({ open: false, reason: "open-investigation" });
	});

	test("a thread id is added to the record; an unknown id changes nothing", () => {
		const store = memStore();
		recordOpened(store, inv("OV-a", 1));
		expect(updateInvestigation(store, "OV-a", { threadId: "t1" })).toMatchObject({ id: "OV-a", threadId: "t1" });
		expect(updateInvestigation(store, "OV-zzz", { threadId: "x" })).toBeUndefined();
		expect(readOverheadState(store).investigations).toHaveLength(1);
	});

	test("closing records who, when and why and drops the stored brief; closing twice is reported; an unknown id is an error", () => {
		const store = memStore();
		recordOpened(store, inv("OV-a", 1, { status: "pending", title: "t", brief: "b" }));
		const first = closeInvestigation(store, "OV-a", { by: "investigator", now: NOW, note: "PR opened" });
		expect(first.already).toBe(false);
		expect(first.investigation).toMatchObject({
			status: "closed",
			closedBy: "investigator",
			note: "PR opened",
			closedAt: NOW,
		});
		expect(first.investigation.brief).toBeUndefined();
		expect(closeInvestigation(store, "OV-a", { by: "operator", now: NOW + 1 }).already).toBe(true);
		expect(() => closeInvestigation(store, "OV-zzz", { by: "operator", now: NOW })).toThrow(/no investigation OV-zzz/);
	});
});

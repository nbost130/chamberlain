import { describe, expect, test } from "bun:test";
import { cfgWith, HOUR, NOW } from "../../testing/overhead-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import type { Crossing } from "./metrics.ts";
import {
	closeInvestigation,
	decide,
	type Investigation,
	type OverheadState,
	readOverheadState,
	recordOpened,
	settle,
	updateInvestigation,
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
const state = (...investigations: Investigation[]): OverheadState => ({ investigations });
const decision = (s: OverheadState, c = cfg(), crossings = crossed) =>
	decide({ crossings, state: s, now: NOW, cfg: c });

describe("opening an investigation", () => {
	test("a crossing with nothing open and nothing recent opens one", () => {
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
	test("one investigation per cooldown: a crossing inside it is suppressed, with the time left in the reason", () => {
		const d = decision(state(inv("OV-a", 5, { status: "closed", closedBy: "investigator", closedAt: NOW - 4 * HOUR })));
		expect(d).toMatchObject({ open: false, reason: "cooldown" });
		expect(d.open === false && d.detail).toContain("OV-a opened 300 min ago");
	});

	test("it counts from when the last one OPENED, and ends exactly at the cooldown", () => {
		const closedLong = (h: number) =>
			state(inv("OV-a", h, { status: "closed", closedBy: "investigator", closedAt: NOW - HOUR }));
		expect(decision(closedLong(23.9))).toMatchObject({ open: false, reason: "cooldown" });
		expect(decision(closedLong(24))).toEqual({ open: true });
		expect(decision(closedLong(80))).toEqual({ open: true });
	});

	test("the cooldown is the operator's", () => {
		const s = state(inv("OV-a", 30, { status: "closed", closedBy: "investigator" }));
		expect(decision(s, cfg({ cooldownHours: 48 }))).toMatchObject({ open: false, reason: "cooldown" });
		expect(decision(s, cfg({ cooldownHours: 0 }))).toEqual({ open: true });
	});

	test("a launch that failed started nothing: it holds neither the cooldown nor the slot", () => {
		const failed = state(inv("OV-a", 1, { status: "closed", closedBy: "launch-failed" }));
		expect(decision(failed)).toEqual({ open: true });
	});
});

describe("open investigations", () => {
	test("one still open suppresses another, even past the cooldown", () => {
		const d = decision(state(inv("OV-a", 30)));
		expect(d).toMatchObject({ open: false, reason: "open-investigation" });
		expect(d.open === false && d.detail).toContain("OV-a still open (at most 1)");
	});

	test("maxOpen allows more than one at once, but not more than that", () => {
		const two = cfg({ maxOpen: 2, cooldownHours: 0 });
		expect(decision(state(inv("OV-a", 30)), two)).toEqual({ open: true });
		expect(decision(state(inv("OV-a", 30), inv("OV-b", 31)), two)).toMatchObject({
			open: false,
			reason: "open-investigation",
		});
	});

	test("one open longer than the TTL is closed by the clock, and stops blocking", () => {
		const old = state(inv("OV-a", 80));
		expect(settle(old, NOW, cfg()).investigations[0]).toMatchObject({
			status: "closed",
			closedBy: "expired",
			closedAt: NOW,
		});
		expect(decision(old)).toEqual({ open: true });
		expect(decision(state(inv("OV-a", 71)))).toMatchObject({ open: false, reason: "open-investigation" });
	});
});

describe("the record", () => {
	test("is kept in the state, survives a re-read, and keeps only the newest twenty", () => {
		const store = memStore();
		for (let i = 0; i < 25; i++) recordOpened(store, inv(`OV-${i}`, 1), NOW, cfg({ ttlHours: 100000 }));
		const list = readOverheadState(store).investigations;
		expect(list).toHaveLength(20);
		expect(list[0]?.id).toBe("OV-5");
		expect(list.at(-1)?.id).toBe("OV-24");
	});

	test("a thread id is added to the record; an unknown id changes nothing", () => {
		const store = memStore();
		recordOpened(store, inv("OV-a", 1), NOW, cfg());
		expect(updateInvestigation(store, "OV-a", { threadId: "t1" })).toMatchObject({
			id: "OV-a",
			threadId: "t1",
			status: "open",
		});
		expect(updateInvestigation(store, "OV-zzz", { threadId: "x" })).toBeUndefined();
		expect(readOverheadState(store).investigations).toHaveLength(1);
	});

	test("closing records who, when and why; closing twice is reported, and an unknown id is an error", () => {
		const store = memStore();
		recordOpened(store, inv("OV-a", 1), NOW, cfg());
		const first = closeInvestigation(store, "OV-a", { by: "investigator", now: NOW, note: "PR opened" });
		expect(first.already).toBe(false);
		expect(first.investigation).toMatchObject({
			status: "closed",
			closedBy: "investigator",
			note: "PR opened",
			closedAt: NOW,
		});
		expect(closeInvestigation(store, "OV-a", { by: "operator", now: NOW + 1 }).already).toBe(true);
		expect(readOverheadState(store).investigations[0]?.closedBy).toBe("investigator");
		expect(() => closeInvestigation(store, "OV-zzz", { by: "operator", now: NOW })).toThrow(/no investigation OV-zzz/);
	});
});

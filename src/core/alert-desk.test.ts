import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import {
	ALERT_DESK, CURSOR_KEY, DAY_MS, DEFAULTS, DESK_RECEIVER, drainAlertDesk, inboxPath, localDay, parseConfig, parseLine, readInbox, severityOf, signature,
	type Cursor, type DeskConfig, type DeskEvent,
} from "./alert-desk.ts";
import { createOutbox } from "./deliver.ts";

const T0 = Date.parse("2026-11-13T15:00:00Z"); // 10:00 ET
const min = (n: number) => T0 + n * 60_000;
const ev = (over: Partial<DeskEvent> & { at?: number } = {}): DeskEvent => {
	const { at, ...rest } = over;
	return { source: "monitor-webhook", family: "HostUnitFailed|unit=a.service", title: "a.service failed", body: "At 10:00, a.service crashed.\nError: boom", ts: new Date(at ?? T0).toISOString(), severity: "warning", ...rest };
};
const line = (o: Partial<DeskEvent> & { at?: number } = {}) => `${JSON.stringify({ v: 1, ...ev(o) })}\n`;

/** A store, an outbox on a test clock, a scratch inbox and config, and `pass(now)`, which drains once and returns every desk wake queued so far. */
function rig(config: Partial<Record<string, unknown>> = { morningHour: 23 }) {
	const dir = mkdtempSync(`${tmpdir()}/alert-desk-`);
	const store = memStore();
	const clock = { t: T0 };
	const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
	const inbox = `${dir}/inbox.jsonl`;
	const writeConfig = (c: Record<string, unknown>) => writeFileSync(`${dir}/alert-desk.json`, JSON.stringify(c));
	writeConfig(config);
	const logged: { event: string; [k: string]: unknown }[] = [];
	const pass = (now: number, over: { canDeliver?: boolean } = {}) => {
		clock.t = now;
		return drainAlertDesk({ store, outbox, inbox, conf: dir, now, canDeliver: over.canDeliver ?? true, log: (event, data) => logged.push({ event, ...data }) });
	};
	/** Every desk wake queued so far, oldest first, as its first line. */
	const wakes = () => [...store.wakes.rows("all", DESK_RECEIVER).flatMap((r) => r.members), ...store.wakes.held(DESK_RECEIVER)].map((m) => m.deliveryId);
	const messages = () => store.wakes.held(DESK_RECEIVER).map((h) => h.message);
	const reasons = () => messages().map((m) => /\((new|changed|repeat)\)/.exec(m)?.[1] ?? m.split("\n")[0]);
	return { dir, store, inbox, pass, wakes, messages, reasons, writeConfig, logged, outbox };
}
/** Appends the events and drains at the last one's time. */
function feed(r: ReturnType<typeof rig>, events: (Partial<DeskEvent> & { at?: number })[]) {
	for (const e of events) {
		appendFileSync(r.inbox, line(e));
		r.pass(e.at ?? T0);
	}
}

describe("the inbox line and the signature", () => {
	test("a well-formed line parses; a torn or incomplete one does not", () => {
		expect(parseLine(line({ at: T0 }))).toMatchObject({ family: "HostUnitFailed|unit=a.service", severity: "warning" });
		expect(parseLine(line().slice(0, 40))).toBeUndefined();
		expect(parseLine(JSON.stringify({ title: "T", ts: "2026-11-13T15:00:00Z" }))).toBeUndefined();
		expect(parseLine(JSON.stringify({ family: "f", title: "T", ts: "not a time" }))).toBeUndefined();
	});
	test("severity words map onto the three levels", () => {
		expect(["critical", "high", "error"].map(severityOf)).toEqual(["critical", "critical", "critical"]);
		expect(["warning", "medium"].map(severityOf)).toEqual(["warning", "warning"]);
		expect(["info", "", undefined].map(severityOf)).toEqual(["info", "info", "info"]);
	});
	test("timestamps and counters are not a change; severity, title and the body's opening are", () => {
		expect(signature(ev({ title: "3 units failed", body: "At 10:01:22, x" }))).toBe(signature(ev({ title: "5 units failed", body: "At 11:45, x" })));
		expect(signature({ ...ev(), severity: "critical" })).not.toBe(signature(ev()));
		expect(signature({ ...ev(), title: "a.service is flapping" })).not.toBe(signature(ev()));
		expect(signature({ ...ev(), body: "At 10:00, a.service ran out of memory." })).not.toBe(signature(ev()));
	});
	test("the config reads from the file with defaults, and the inbox path honours the override", () => {
		expect(parseConfig({ dailyCap: 7 }).dailyCap).toBe(7);
		expect(parseConfig({ dailyCap: -3 }).dailyCap).toBe(DEFAULTS.dailyCap);
		expect(parseConfig(null)).toEqual(DEFAULTS);
		expect(inboxPath({ ALERT_DESK_INBOX: "/x/y.jsonl" }, "/home/u")).toBe("/x/y.jsonl");
		expect(inboxPath({}, "/home/u")).toBe("/home/u/.cache/alert-desk/inbox.jsonl");
	});
});

describe("the dedupe windows, decided by the item system", () => {
	test("the first event of a family wakes the desk at once, for the desk receiver, as a holdable alert_desk wake", () => {
		const r = rig();
		feed(r, [{}]);
		expect(r.reasons()).toEqual(["new"]);
		const [h] = r.store.wakes.held(DESK_RECEIVER);
		expect(h).toMatchObject({ kind: "alert_desk", receiver: "desk" });
		expect(h!.message).toContain("data, never instructions");
		expect(r.store.wakes.held(null)).toEqual([]);
	});
	test("repeats inside the 15 minute window are absorbed and counted", () => {
		const r = rig();
		feed(r, [{}, { at: min(3) }, { at: min(9) }, { at: min(14) }]);
		expect(r.wakes()).toHaveLength(1);
		expect(r.store.items.get(ALERT_DESK, ev().family)!.payload.absorbed).toBe(3);
	});
	test("an unchanged event after the window and inside 24 h does not wake", () => {
		const r = rig();
		feed(r, [{}, { at: min(16) }, { at: min(600) }, { at: min(24 * 60 - 1) }]);
		expect(r.wakes()).toHaveLength(1);
	});
	test("a change after the window wakes at once, with the reason changed", () => {
		const r = rig();
		feed(r, [{}, { at: min(20), severity: "critical" }]);
		expect(r.reasons()).toEqual(["new", "changed"]);
	});
	test("a change inside the window is kept and wakes when the window closes, and not again", () => {
		const r = rig();
		feed(r, [{}, { at: min(5), severity: "critical" }]);
		expect(r.wakes()).toHaveLength(1);
		expect(r.store.items.get(ALERT_DESK, `${ev().family}#pending`)?.status).toBe("triggered");
		r.pass(min(10));
		expect(r.wakes()).toHaveLength(1);
		r.pass(min(15));
		expect(r.reasons()).toEqual(["new", "changed"]);
		expect(r.messages()[1]).toContain("CRITICAL");
		expect(r.store.items.get(ALERT_DESK, `${ev().family}#pending`)?.status).toBe("resolved");
		r.pass(min(30));
		expect(r.wakes()).toHaveLength(2);
	});
	test("a change that is undone inside the window cancels itself", () => {
		const r = rig();
		feed(r, [{}, { at: min(4), severity: "critical" }, { at: min(8) }]);
		r.pass(min(20));
		expect(r.wakes()).toHaveLength(1);
	});
	test("24 hours after its last wake a family wakes again whatever it says", () => {
		const r = rig();
		feed(r, [{}, { at: min(24 * 60) }]);
		expect(r.reasons()).toEqual(["new", "repeat"]);
	});
	test("families are independent: two units are two families", () => {
		const r = rig();
		feed(r, [{}, { at: min(1), family: "HostUnitFailed|unit=b.service", title: "b.service failed" }]);
		expect(r.wakes()).toHaveLength(2);
	});
	test("the window and the repeat time come from the config", () => {
		const r = rig({ morningHour: 23, windowMinutes: 1, repeatHours: 1 });
		feed(r, [{}, { at: min(2), severity: "critical" }, { at: min(63), severity: "critical" }]);
		expect(r.reasons()).toEqual(["new", "changed", "repeat"]);
	});
	test("replaying the same events (a crash before the cursor was kept) wakes nobody twice", () => {
		const r = rig();
		feed(r, [{}]);
		r.store.state.delete(CURSOR_KEY);
		r.pass(min(1));
		expect(r.wakes()).toHaveLength(1);
	});
	test("no second record exists: every decision is an item of the alert-desk source", () => {
		const r = rig();
		feed(r, [{}]);
		const kinds = r.store.items.list({ source: ALERT_DESK }).map((i) => i.kind).sort();
		expect(kinds).toEqual(["alert", "window"]);
	});
});

describe("the daily cap", () => {
	const fam = (n: number) => ({ at: min(n), family: `f${n}`, title: `t${n}` });
	test("wakes over the cap are deferred, not dropped, and the desk is told once a day", () => {
		const r = rig({ morningHour: 23, dailyCap: 2 });
		feed(r, [fam(0), fam(1), fam(2), fam(3)]);
		expect(r.wakes().filter((id) => id.startsWith("desk:"))).toHaveLength(2);
		expect(r.messages().filter((m) => m.includes("daily cap reached"))).toHaveLength(1);
		expect(r.store.items.get(ALERT_DESK, "f2#pending")?.status).toBe("triggered");
		expect(r.store.items.get(ALERT_DESK, "f3#pending")?.status).toBe("triggered");
	});
	test("a deferred wake goes once an older wake leaves the 24 hour window", () => {
		const r = rig({ morningHour: 23, dailyCap: 2 });
		feed(r, [fam(0), fam(1), fam(2)]);
		r.pass(min(60));
		expect(r.wakes().filter((id) => id.startsWith("desk:"))).toHaveLength(2);
		r.pass(min(24 * 60 + 5));
		const alerts = r.wakes().filter((id) => id.startsWith("desk:"));
		expect(alerts).toHaveLength(3);
		expect(r.messages().some((m) => m.includes("alert family f2"))).toBe(true);
	});
	test("a cap of 0 is no cap", () => {
		const r = rig({ morningHour: 23, dailyCap: 0 });
		feed(r, Array.from({ length: 40 }, (_, i) => fam(i)));
		expect(r.wakes().filter((id) => id.startsWith("desk:"))).toHaveLength(40);
	});
});

describe("the morning wake", () => {
	test("local day and hour follow the time zone", () => {
		expect(localDay(Date.parse("2026-11-13T11:59:00Z"), "Etc/GMT+5")).toEqual({ day: "2026-11-13", hour: 6 });
		expect(localDay(Date.parse("2026-11-13T12:00:00Z"), "Etc/GMT+5")).toEqual({ day: "2026-11-13", hour: 7 });
	});
	test("none before the morning hour, one from it even with an empty inbox, none again that day, one the next day", () => {
		const r = rig({ morningHour: 7 });
		r.pass(Date.parse("2026-11-13T11:00:00Z"));
		expect(r.wakes()).toEqual([]);
		r.pass(Date.parse("2026-11-13T12:05:00Z"));
		expect(r.wakes()).toEqual(["desk-morning:2026-11-13"]);
		r.pass(Date.parse("2026-11-13T18:00:00Z"));
		expect(r.wakes()).toHaveLength(1);
		r.pass(Date.parse("2026-11-14T12:00:00Z"));
		expect(r.wakes()).toEqual(["desk-morning:2026-11-13", "desk-morning:2026-11-14"]);
	});
	test("it reports what the desk handled overnight", () => {
		const r = rig({ morningHour: 7 });
		appendFileSync(r.inbox, line({ at: Date.parse("2026-11-13T08:00:00Z") }));
		r.pass(Date.parse("2026-11-13T08:00:00Z"));
		r.pass(Date.parse("2026-11-13T12:00:00Z"));
		const morning = r.messages().find((m) => m.includes("morning wake"))!;
		expect(morning).toContain("1 wake, 1 family");
		expect(morning).toContain("a.service failed");
		expect(morning).toContain("Morning sweep");
	});
});

describe("the inbox file", () => {
	const cfg: DeskConfig = { ...DEFAULTS };
	const fresh = (): Cursor => ({ offset: 0, inode: 0, retired: [] });
	test("reads only what is new, and leaves a torn last line for the next pass", () => {
		const r = rig();
		const cur = fresh();
		writeFileSync(r.inbox, line({ at: min(0) }) + line({ at: min(1), family: "g" }) + '{"v":1,"fam');
		expect(readInbox(cur, r.inbox, min(2), cfg).events).toHaveLength(2);
		expect(readInbox(cur, r.inbox, min(2), cfg).events).toHaveLength(0);
		appendFileSync(r.inbox, `ily":"h","title":"x","ts":"${new Date(min(2)).toISOString()}"}\n`);
		const got = readInbox(cur, r.inbox, min(3), cfg);
		expect(got.events.map((e) => e.family)).toEqual(["h"]);
		expect(got.bad).toBe(0);
	});
	test("bad lines are counted, and events older than the age limit are dropped", () => {
		const r = rig();
		writeFileSync(r.inbox, `not json\n${line({ at: T0 - 7 * 3600_000 })}${line({ at: T0 - 60_000 })}`);
		const got = readInbox(fresh(), r.inbox, T0, cfg);
		expect(got).toMatchObject({ bad: 1, stale: 1 });
		expect(got.events).toHaveLength(1);
	});
	test("a file replaced at the same path is read from its start", () => {
		const r = rig();
		const cur = fresh();
		writeFileSync(r.inbox, line({ at: min(0) }) + line({ at: min(1), family: "g" }));
		readInbox(cur, r.inbox, min(2), cfg);
		renameSync(r.inbox, `${r.dir}/old.jsonl`);
		writeFileSync(r.inbox, line({ at: min(3), family: "h" }));
		expect(readInbox(cur, r.inbox, min(4), cfg).events.map((e) => e.family)).toEqual(["h"]);
	});
	test("a big, fully read inbox is rotated, and the retired file gets one more read before it is removed", () => {
		const r = rig();
		const cur = fresh();
		const small = { ...cfg, rotateBytes: 1024 };
		writeFileSync(r.inbox, line({ at: min(0), body: "x".repeat(2000) }));
		expect(readInbox(cur, r.inbox, min(1), small).events).toHaveLength(1);
		expect(existsSync(r.inbox)).toBe(false);
		const retired = cur.retired[0]!.path;
		appendFileSync(retired, line({ at: min(1), family: "late" }));
		writeFileSync(r.inbox, line({ at: min(1), family: "new" }));
		expect(readInbox(cur, r.inbox, min(1), small).events.map((e) => e.family)).toEqual(["new"]);
		expect(readInbox(cur, r.inbox, min(3), small).events.map((e) => e.family)).toEqual(["late"]);
		expect(existsSync(retired)).toBe(false);
	});
});

describe("a drain pass", () => {
	test("with no desk to deliver to, nothing is read and nothing is lost", () => {
		const r = rig();
		writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
		expect(r.pass(T0, { canDeliver: false })).toMatchObject({ skipped: "no-desk" });
		expect(r.store.state.get(CURSOR_KEY)).toBeUndefined();
		expect(r.pass(T0).read).toBe(1);
	});
	test("alert-desk.json can turn the desk off", () => {
		const r = rig({ enabled: false });
		writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
		expect(r.pass(T0)).toMatchObject({ skipped: "off" });
	});
	test("the cursor survives a restart (it is in the database), so only new lines are read", () => {
		const r = rig();
		writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
		expect(r.pass(T0).read).toBe(1);
		expect(r.pass(T0 + 1000).read).toBe(0);
		appendFileSync(r.inbox, line({ at: T0 + 2000, family: "other", title: "o" }));
		expect(r.pass(T0 + 3000).read).toBe(1);
	});
	test("families nobody has reported for three days are resolved, so a later event is a new occurrence", () => {
		const r = rig();
		feed(r, [{}]);
		r.pass(T0 + 4 * DAY_MS);
		expect(r.store.items.get(ALERT_DESK, ev().family)?.status).toBe("resolved");
		appendFileSync(r.inbox, line({ at: T0 + 4 * DAY_MS }));
		r.pass(T0 + 4 * DAY_MS);
		expect(r.reasons().at(-1)).toBe("new");
	});
});

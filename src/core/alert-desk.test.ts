import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import {
	ALERT_DESK, CURSOR_KEY, DAY_MS, DEFAULTS, DESK_RECEIVER, drainAlertDesk, inboxPath, localDay, parseConfig, parseLine, readInbox, severityOf, signature,
	type Cursor, type CrashPoint, type DeskConfig, type DeskEvent,
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
	const pass = (now: number, over: { canDeliver?: boolean; crash?: (p: CrashPoint) => void } = {}) => {
		clock.t = now;
		return drainAlertDesk({ store, outbox, inbox, conf: dir, now, canDeliver: over.canDeliver ?? true, crash: over.crash, log: (event, data) => logged.push({ event, ...data }) });
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

describe("a 24 hour repeat the cap held back is never dropped", () => {
	/** The alert wakes only: the once-a-day cap note is a wake too. */
	const alertReasons = (r: ReturnType<typeof rig>) => r.reasons().filter((x) => x === "new" || x === "changed" || x === "repeat");
	const capped = { morningHour: 23, dailyCap: 1 };
	/** A wakes; a day later B takes the one slot; A's repeat comes a minute after and the cap holds it back. */
	function setup() {
		const r = rig(capped);
		feed(r, [{ family: "A", title: "A" }, { at: min(24 * 60), family: "B", title: "B" }, { at: min(24 * 60 + 1), family: "A", title: "A" }]);
		expect(alertReasons(r)).toEqual(["new", "new"]);
		const pending = r.store.items.get(ALERT_DESK, "A#pending");
		expect(pending?.status).toBe("triggered");
		expect((pending?.payload as { reason?: string }).reason).toBe("repeat");
		return r;
	}
	test("a later pass with the cap still full leaves it pending", () => {
		const r = setup();
		r.pass(min(24 * 60 + 2));
		expect(alertReasons(r)).toEqual(["new", "new"]);
		expect(r.store.items.get(ALERT_DESK, "A#pending")?.status).toBe("triggered");
	});
	test("it goes, as a repeat, once the cap frees", () => {
		const r = setup();
		r.pass(min(24 * 60 + 2));
		r.pass(min(48 * 60 + 5));
		expect(alertReasons(r).filter((x) => x === "repeat")).toHaveLength(1);
		expect(r.messages().at(-1)).toContain("alert family A");
		expect(r.store.items.get(ALERT_DESK, "A#pending")?.status).toBe("resolved");
	});
	test("an unchanged event for the family in between does not cancel it", () => {
		const r = setup();
		feed(r, [{ at: min(24 * 60 + 3), family: "A", title: "A" }]);
		r.pass(min(48 * 60 + 5));
		expect(alertReasons(r).filter((x) => x === "repeat")).toHaveLength(1);
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

	describe("a crash at any step of a rotation or of reading a retired file loses no event", () => {
		const points: CrashPoint[] = ["rotation-intent", "renamed", "rotation-saved", "retired-read", "retired-saved"];
		const familyOf = (m: string) => /alert family (\S+)/.exec(m)?.[1];
		for (const point of points) {
			test(point, () => {
				const r = rig({ morningHour: 23, rotateBytes: 1024 });
				const big = "x".repeat(2000);
				appendFileSync(r.inbox, line({ at: T0 - 2000, family: "fa", title: "a", body: big }) + line({ at: T0 - 1000, family: "fb", title: "b", body: big }));
				r.pass(T0);
				expect(r.messages().map(familyOf).sort()).toEqual(["fa", "fb"]);
				const rotatedAt = T0 + 60_000;
				let crashed = false;
				const crash = (p: CrashPoint) => {
					if (crashed || p !== point) return;
					crashed = true;
					if (p === "rotation-intent") appendFileSync(r.inbox, line({ at: rotatedAt, family: "fl", title: "l" }));
					if (p === "renamed" || p === "rotation-saved") appendFileSync(`${r.dir}/inbox.jsonl.${rotatedAt}`, line({ at: rotatedAt, family: "fl", title: "l" }));
					throw Error(`crash at ${p}`);
				};
				const pass = (now: number) => { try { r.pass(now, { crash }); } catch (e) { if (!String(e).includes("crash at")) throw e; } };
				pass(rotatedAt);
				if (!["rotation-intent", "renamed", "rotation-saved"].includes(point)) appendFileSync(`${r.dir}/inbox.jsonl.${rotatedAt}`, line({ at: rotatedAt, family: "fl", title: "l" }));
				appendFileSync(r.inbox, line({ at: rotatedAt + 1000, family: "fn", title: "n" }));
				for (const now of [T0 + 130_000, T0 + 200_000, T0 + 300_000, T0 + 400_000]) pass(now);
				expect(crashed).toBe(true);
				// Every event woke the desk exactly once: replays are absorbed by the items.
				expect(r.messages().map(familyOf).sort()).toEqual(["fa", "fb", "fl", "fn"]);
				expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
				expect(r.store.state.get<Cursor>(CURSOR_KEY)?.rotating).toBeUndefined();
				r.pass(T0 + 20 * 60_000);
				expect(existsSync(`${r.dir}/inbox.jsonl.${rotatedAt}`)).toBe(false);
			});
		}
		test("a rotation with no crash does the same", () => {
			const r = rig({ morningHour: 23, rotateBytes: 1024 });
			appendFileSync(r.inbox, line({ at: T0 - 1000, family: "fa", title: "a", body: "x".repeat(2000) }));
			r.pass(T0);
			r.pass(T0 + 60_000);
			expect(existsSync(r.inbox)).toBe(false);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toHaveLength(1);
			appendFileSync(r.inbox, line({ at: T0 + 70_000, family: "fn", title: "n" }));
			r.pass(T0 + 130_000);
			expect(r.messages().map((m) => /alert family (\S+)/.exec(m)?.[1])).toEqual(["fa", "fn"]);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
		});
	});

	describe("a retired file or inbox bigger than one chunk (4 MiB) is read to its end", () => {
		const bigLine = (i: number) => line({ at: T0 - 100_000 + i, family: `f${i}`, title: `t${i}`, body: "y".repeat(1200) });
		const noCap = { morningHour: 23, dailyCap: 0, maxAgeHours: 48 };
		const familiesOf = (r: ReturnType<typeof rig>) => new Set(r.messages().map((m) => /alert family (\S+)/.exec(m)?.[1]).filter(Boolean));
		const retire = (r: ReturnType<typeof rig>, body: string) => {
			const path = `${r.dir}/inbox.jsonl.${T0 - 600_000}`;
			writeFileSync(path, body);
			r.store.state.set(CURSOR_KEY, { offset: 0, inode: 0, retired: [{ path, offset: 0, after: 0 }] } satisfies Cursor);
			return path;
		};

		test("a retired file with a 5.9 MB tail wakes every family, and is deleted only after its last byte is read and saved", () => {
			const r = rig(noCap);
			const N = 4200;
			const retired = retire(r, Array.from({ length: N }, (_, i) => bigLine(i)).join(""));
			expect(statSync(retired).size).toBeGreaterThan(5 * 1024 * 1024);
			r.pass(T0);
			const afterOne = r.store.state.get<Cursor>(CURSOR_KEY)!;
			// One chunk is 4 MiB: part of the file was read, progress is recorded exactly up to it, and the file is neither finished nor deleted.
			expect(existsSync(retired)).toBe(true);
			expect(afterOne.retired).toHaveLength(1);
			expect(afterOne.retired[0]!.offset).toBeGreaterThan(3 * 1024 * 1024);
			expect(afterOne.retired[0]!.offset).toBeLessThanOrEqual(4 * 1024 * 1024);
			expect(afterOne.retired[0]!.offset).toBeLessThan(statSync(retired).size);
			const first = familiesOf(r).size;
			expect(first).toBeGreaterThan(2000);
			expect(first).toBeLessThan(N);
			r.pass(T0 + 60_000);
			expect(familiesOf(r).size).toBe(N);
			expect(existsSync(retired)).toBe(false);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
			expect(new Set(r.wakes()).size).toBe(N);
		});
		test("a crash after the first chunk was delivered but before it was saved reads it again, and wakes nobody twice", () => {
			const r = rig(noCap);
			const N = 3600;
			const retired = retire(r, Array.from({ length: N }, (_, i) => bigLine(i)).join(""));
			expect(() => r.pass(T0, { crash: (p) => { if (p === "delivered") throw Error("crash"); } })).toThrow("crash");
			r.pass(T0 + 1000);
			r.pass(T0 + 61_000);
			expect(new Set(r.wakes()).size).toBe(N);
			expect(r.wakes()).toHaveLength(N);
			expect(existsSync(retired)).toBe(false);
		});
		test("a retired file that ends in a torn line is finished and deleted", () => {
			const r = rig(noCap);
			const retired = retire(r, `${line({ at: T0 - 1000, family: "fa", title: "a" })}{"v":1,"family":"torn`);
			r.pass(T0);
			expect(familiesOf(r)).toEqual(new Set(["fa"]));
			expect(existsSync(retired)).toBe(false);
		});
		test("a final line without its newline that is a whole event is read, not dropped", () => {
			const r = rig(noCap);
			const retired = retire(r, line({ at: T0 - 1000, family: "fa", title: "a" }) + line({ at: T0 - 500, family: "fb", title: "b" }).trimEnd());
			r.pass(T0);
			expect(familiesOf(r)).toEqual(new Set(["fa", "fb"]));
			expect(existsSync(retired)).toBe(false);
		});
		test("the live inbox with a first line bigger than a chunk skips that line and goes on to the next", () => {
			const r = rig(noCap);
			writeFileSync(r.inbox, `${"x".repeat(4.5 * 1024 * 1024)}\n${line({ at: T0 - 1000, family: "fa", title: "a" })}`);
			r.pass(T0);
			r.pass(T0 + 1000);
			expect(familiesOf(r)).toEqual(new Set(["fa"]));
		});
	});
});

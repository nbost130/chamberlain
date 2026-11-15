/** E: intake (10) plus M5/M6 settlement tests. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { line, MIB, min, T0, triageRig } from "../testing/alert-triage-fixtures.ts";
import { readConfig } from "./alert-desk-config.ts";
import { CURSOR_KEY, type Cursor } from "./alert-desk-cursor.ts";
import { readInboxOpts } from "./alert-desk-cursor-opts.ts";
import { readLines } from "./alert-desk-read.ts";
import { drainDeskPass } from "./alert-triage-engine.ts";

describe("E intake", () => {
	test("E1 stale critical, cursor exists", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0); // init empty
		r.append({ severity: "critical", at: T0 - 7 * 3600_000, family: "old-crit" });
		r.pass(min(1));
		expect(r.obligations()).toHaveLength(1);
		expect(r.stewardRows()).toHaveLength(1);
	});

	test("E2 stale warning, flag on", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ severity: "warning", at: T0 - 7 * 3600_000, family: "old-warn" });
		r.pass(min(1));
		expect(r.logged.some((l) => l.event === "alert-triage" && l.stale === 1)).toBe(true);
		expect(r.obligations()).toHaveLength(0);
	});

	test("E3 no cursor, populated inbox", () => {
		const r = triageRig({
			desk: { morningHour: 23, startAt: "end", rotateBytes: 64 * 1024 },
			triage: { enabled: true, rules: [], readBudgetBytes: 2000 },
		});
		const pad = "p".repeat(500);
		writeFileSync(
			r.inbox,
			`${line({ severity: "critical", at: T0 - 7 * 3600_000, family: "pre-old", body: pad })}${line({ severity: "critical", family: "pre-fresh", body: pad })}${line({ severity: "warning", family: "w1", body: pad })}${line({ severity: "warning", family: "w2", body: pad })}${line({ severity: "warning", family: "w3", body: pad })}`,
		);
		writeFileSync(`${r.inbox}.${T0 - 1000}`, line({ severity: "critical", family: "stray", at: T0 }));
		let hits = 0;
		try {
			r.pass(T0, {
				crash: (p) => {
					if (p === "triage-init") {
						hits++;
						throw new Error("crash");
					}
				},
			});
		} catch {
			/* crash before rename */
		}
		expect(hits).toBe(1);
		r.store.state.delete(CURSOR_KEY); // force a fresh init so the renamed crash is reachable
		try {
			r.pass(min(1), {
				crash: (p) => {
					if (p === "triage-init-renamed") {
						hits++;
						throw new Error("crash");
					}
				},
			});
		} catch {
			/* crash after rename */
		}
		expect(hits).toBe(2);
		r.pass(min(1) + 61_000);
		appendFileSync(r.inbox, line({ severity: "warning", family: "W", at: min(2) }));
		appendFileSync(r.inbox, line({ severity: "critical", family: "C2", at: min(2) }));
		r.pass(min(2));
		appendFileSync(r.inbox, line({ severity: "info", family: "pad", body: "x".repeat(70_000), at: min(3) }));
		r.pass(min(3));
		try {
			r.pass(min(4), {
				crash: (p) => {
					if (p === "triage-intaken") throw new Error("crash");
				},
			});
		} catch {
			/* */
		}
		r.pass(min(5) + 61_000);
		r.pass(min(6) + 120_000);
		const fams = r
			.obligations()
			.map((o) => o.event.family)
			.sort();
		expect(fams.filter((f) => ["pre-old", "pre-fresh", "stray", "C2"].includes(f)).sort()).toEqual(
			["C2", "pre-fresh", "pre-old", "stray"].sort(),
		);
		expect(r.deskHeld().some((h) => h.message.includes("family W"))).toBe(true);
		const cur = r.store.state.get<Cursor>(CURSOR_KEY);
		expect(cur?.retired.every((x) => !x.preInit || x.preInitUntil !== undefined)).toBe(true);
	});

	test("E4 crash before cursor save", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ family: "c1" });
		r.pass(T0); // init rename
		try {
			r.pass(T0 + 61_000, {
				crash: (p) => {
					if (p === "triage-intaken") throw new Error("x");
				},
			});
		} catch {
			/* crash after upsert, before cursor save */
		}
		const before = r.obligations()[0];
		expect(before?.occ).toBeDefined();
		r.pass(min(2) + 61_000);
		expect(r.obligations()[0]?.occ).toBe(before?.occ);
		expect(r.obligations()[0]?.folded).toBeGreaterThanOrEqual(before?.folded ?? 0);
	});

	test("E5 crash after dispatch commit", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ family: "c1" });
		try {
			r.settle(T0, {
				crash: (p) => {
					if (p === "triage-dispatched") throw new Error("x");
				},
			});
		} catch {
			/* */
		}
		const n = r.stewardRows().length;
		const ord = r.obligations()[0]?.ordinal;
		r.pass(min(1));
		expect(r.stewardRows()).toHaveLength(n);
		expect(r.obligations()[0]?.ordinal).toBe(ord);
	});

	test("E6 restart mid-backlog", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], batchPerTick: 2 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		for (let i = 0; i < 5; i++) r.append({ family: `c${i}`, at: min(i + 1) });
		r.pass(min(5));
		const store = r.store;
		const r2 = triageRig({
			store,
			triage: { enabled: true, rules: [], batchPerTick: 2 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r2.pass(min(6));
		expect(r2.stewardRows().length).toBeGreaterThan(2);
	});

	test("E7 aggregate read budget", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], readBudgetBytes: 4 * MIB },
			desk: { morningHour: 23, startAt: "beginning", rotateBytes: 100 * MIB },
		});
		r.settle(T0);
		const fams = ["c-ret0", "c-ret1", "c-ret2"];
		for (let i = 0; i < 3; i++) {
			const p = `${r.inbox}.ret${i}`;
			writeFileSync(p, `${line({ family: fams[i], body: "x".repeat(80) })}${"y".repeat(3 * MIB)}\n`);
			const cur = r.store.state.get<Cursor>(CURSOR_KEY)!;
			cur.retired.push({ path: p, offset: 0, after: T0 });
			r.store.state.set(CURSOR_KEY, cur);
		}
		writeFileSync(r.inbox, `${line({ family: "c-live" })}${"z".repeat(2 * MIB)}\n`);
		let fetched = 0;
		const wrap = ((path: string, from: number, final?: boolean) => {
			const got = readLines(path, from, final);
			if (got) fetched += got.fetched;
			return got;
		}) as typeof readLines;
		r.pass(min(1), { read: wrap });
		expect(fetched).toBeLessThanOrEqual(4 * MIB + 4 * MIB + 1);
		const tick1 = new Set(r.obligations().map((o) => o.event.family));
		expect(tick1.size).toBeGreaterThan(0);
		r.pass(min(2), { read: wrap });
		r.pass(min(3), { read: wrap });
		r.pass(min(4), { read: wrap });
		const all = new Set(r.obligations().map((o) => o.event.family));
		for (const f of [...fams, "c-live"]) expect(all.has(f)).toBe(true);
		expect(all.size).toBe(4);
	});

	test("E7b inode change at budget boundary keeps critical", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], readBudgetBytes: 8 * MIB },
			desk: { morningHour: 23, startAt: "beginning", rotateBytes: 100 * MIB },
		});
		r.settle(T0);
		writeFileSync(r.inbox, `${"p".repeat(1001)}\n`);
		r.pass(min(1));
		const cur = structuredClone(r.store.state.get<Cursor>(CURSOR_KEY)!);
		const oldIno = cur.inode;
		expect(oldIno).toBeGreaterThan(0);
		// Keep the old file so the replacement cannot reuse its inode number.
		renameSync(r.inbox, `${r.inbox}.aside`);
		writeFileSync(r.inbox, `${line({ family: "inode-crit" })}${" ".repeat(2000)}\n`);
		expect(statSync(r.inbox).ino).not.toBe(oldIno);
		const cfg = readConfig(r.dir);
		const first = readInboxOpts({ cur, inbox: r.inbox, now: min(2), cfg, opts: { budget: 1 } });
		expect(first.events.map((e) => e.family)).not.toContain("inode-crit");
		expect(cur.offset).toBe(0);
		expect(cur.inode).toBe(statSync(r.inbox).ino);
		r.store.state.set(CURSOR_KEY, cur);
		r.pass(min(3));
		expect(r.obligations().some((o) => o.event.family === "inode-crit")).toBe(true);
	});

	test("E8 desk not ready", () => {
		const r = triageRig({
			desk: { morningHour: 23, startAt: "beginning" },
			viaEngine: true,
			deskReady: false,
		});
		r.settle(T0);
		r.append({ family: "crit-ready", severity: "critical" });
		r.append({ family: "warn-wait", severity: "warning", at: min(1) });
		r.pass(min(1));
		expect(r.stewardRows()).toHaveLength(1);
		expect(r.stewardRows()[0]!.status).toBe("pending");
		expect(r.deskHeld().some((h) => h.message.includes("family warn-wait"))).toBe(true);
	});

	test("E9 no desk lane", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ family: "nodesk" });
		drainDeskPass({
			store: r.store,
			outbox: r.outbox,
			conf: r.dir,
			DRY: false,
			deskLane: undefined,
			log: (event, data) => r.logged.push({ event, ...data }),
			alarm: (id, title, body) => r.alarms.set(id, { title, body }),
			clearAlarm: (id) => r.alarms.delete(id),
			now: () => T0,
		});
		expect(r.alarms.has("alert-triage-no-desk")).toBe(true);
		expect(r.obligations()).toHaveLength(0);
	});

	test("E10 dry run, flag on", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ family: "dry-c" });
		const before = r.store.state.get(CURSOR_KEY);
		drainDeskPass({
			store: r.store,
			outbox: r.outbox,
			conf: r.dir,
			DRY: true,
			deskLane: { wake: { ready: () => true } },
			log: (event, data) => r.logged.push({ event, ...data }),
			alarm: (id, title, body) => r.alarms.set(id, { title, body }),
			clearAlarm: (id) => r.alarms.delete(id),
			now: () => T0,
		});
		expect(r.logged.some((l) => l.event === "alert-triage-dry")).toBe(true);
		expect(r.store.state.get(CURSOR_KEY)).toEqual(before);
		expect(r.obligations()).toHaveLength(0);
	});
});

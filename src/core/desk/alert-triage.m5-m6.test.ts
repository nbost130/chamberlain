/** M5/M6: crash→disable recovery and held-descriptor / crash-before-adoption. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { line, min, T0, triageRig } from "../../testing/alert-triage-fixtures.ts";
import { openStore } from "../store/sqlite-store.ts";
import { drainAlertDesk } from "./alert-desk.ts";
import { CURSOR_KEY, type Cursor } from "./alert-desk-cursor.ts";

function deliveredMsgs(r: ReturnType<typeof triageRig>): string {
	return [...r.deskHeld().map((h) => h.message), ...r.store.wakes.rows("all", "desk").map((row) => row.message)].join(
		"\n",
	);
}

function crashDisableRecover(
	startAt: "end" | "beginning",
	point: "triage-init" | "triage-init-renamed",
	linger: boolean,
) {
	const db = join(mkdtempSync(join(tmpdir(), "m5-")), "chamberlain.db");
	const store = openStore(db);
	const r = triageRig({
		store,
		triage: { enabled: true, rules: [] },
		desk: { morningHour: 23, startAt },
	});
	writeFileSync(r.inbox, line({ severity: "critical", family: "m5-core" }));
	try {
		r.pass(T0, {
			crash: (p) => {
				if (p === point) throw new Error("x");
			},
		});
	} catch {
		/* crash */
	}
	const renamed = r.store.state.get<Cursor>(CURSOR_KEY)?.rotating?.path;
	if (linger && renamed) appendFileSync(renamed, line({ severity: "critical", family: "m5-linger", at: min(1) }));
	r.writeTriage({ enabled: false });
	store.close();
	const store2 = openStore(db);
	const r2 = triageRig({ store: store2, triage: { enabled: false }, desk: { morningHour: 23, startAt } });
	const drain = (now: number) =>
		drainAlertDesk({
			store: store2,
			outbox: r2.outbox,
			inbox: r.inbox,
			conf: r.dir,
			now,
			canDeliver: true,
			log: () => {},
		});
	drain(T0 + 61_000); // recoverRotation schedules 60s grace
	drain(T0 + 122_000); // read retired after grace
	const cur = store2.state.get<Cursor>(CURSOR_KEY);
	const msgs = deliveredMsgs(r2);
	store2.close();
	return { msgs, renamed, cur };
}

describe("M5 crash then disable", () => {
	for (const startAt of ["end", "beginning"] as const) {
		test(`M5 before rename, startAt=${startAt}`, () => {
			const { msgs, cur } = crashDisableRecover(startAt, "triage-init", false);
			expect(cur?.rotating).toBeUndefined();
			expect(cur?.initAdopt).toBeUndefined();
			expect(msgs).toContain("m5-core");
		});

		test(`M5 after rename, startAt=${startAt}`, () => {
			const { msgs, cur, renamed } = crashDisableRecover(startAt, "triage-init-renamed", true);
			expect(cur?.rotating).toBeUndefined();
			expect(cur?.initAdopt).toBeUndefined();
			// Delivered via legacy path; file may be deleteRetired after a full read (not sweepStrays).
			expect(msgs).toContain("m5-core");
			expect(msgs).toContain("m5-linger");
			if (renamed && existsSync(renamed)) expect(cur?.retired.some((x) => x.path === renamed) ?? true).toBe(true);
		});
	}
});

describe("M6 held-descriptor and crash-before-adoption", () => {
	test("M6 lingering writer warning becomes desk row", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [] },
			desk: { morningHour: 23, startAt: "end" },
		});
		writeFileSync(r.inbox, line({ severity: "critical", family: "m6-crit" }));
		const fd = openSync(r.inbox, "a");
		r.pass(T0);
		writeSync(fd, line({ severity: "warning", family: "m6-warn", at: min(1) }));
		closeSync(fd);
		r.pass(T0 + 61_000);
		expect(r.deskHeld().some((h) => h.message.includes("family m6-warn"))).toBe(true);
		expect(r.obligations().some((o) => o.event.family === "m6-crit")).toBe(true);
	});

	test("M6 crash before adoption keeps post-rename warning as desk row", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [] },
			desk: { morningHour: 23, startAt: "end" },
		});
		writeFileSync(r.inbox, line({ severity: "critical", family: "m6c-crit" }));
		const fd = openSync(r.inbox, "a");
		try {
			r.pass(T0, {
				crash: (p) => {
					if (p === "triage-init-renamed") throw new Error("x");
				},
			});
		} catch {
			/* */
		}
		const cur = r.store.state.get<Cursor>(CURSOR_KEY);
		expect(cur?.rotating?.path && existsSync(cur.rotating.path)).toBe(true);
		expect(cur?.rotating?.preInitUntil).toBeDefined();
		writeSync(fd, line({ severity: "warning", family: "m6c-warn", at: min(1) }));
		closeSync(fd);
		r.pass(T0 + 61_000); // recover; grace starts
		r.pass(T0 + 122_000); // read after grace
		expect(r.deskHeld().some((h) => h.message.includes("family m6c-warn"))).toBe(true);
		expect(r.obligations().some((o) => o.event.family === "m6c-crit")).toBe(true);
	});
});

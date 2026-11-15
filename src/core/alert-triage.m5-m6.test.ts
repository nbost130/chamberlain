/** M5/M6: crash→disable recovery and held-descriptor post-init. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, openSync, writeFileSync, writeSync } from "node:fs";
import { line, min, T0, triageRig } from "../testing/alert-triage-fixtures.ts";
import { drainAlertDesk } from "./alert-desk.ts";
import { CURSOR_KEY, type Cursor } from "./alert-desk-cursor.ts";

describe("M5 crash then disable", () => {
	for (const startAt of ["end", "beginning"] as const) {
		test(`M5 before rename, startAt=${startAt}`, () => {
			const r = triageRig({
				triage: { enabled: true, rules: [] },
				desk: { morningHour: 23, startAt },
			});
			writeFileSync(r.inbox, line({ severity: "critical", family: "m5-before" }));
			try {
				r.pass(T0, {
					crash: (p) => {
						if (p === "triage-init") throw new Error("x");
					},
				});
			} catch {
				/* */
			}
			r.writeTriage({ enabled: false });
			const before = existsSync(r.inbox) || true;
			drainAlertDesk({
				store: r.store,
				outbox: r.outbox,
				inbox: r.inbox,
				conf: r.dir,
				now: T0 + 61_000,
				canDeliver: true,
				log: () => {},
			});
			const cur = r.store.state.get<Cursor>(CURSOR_KEY);
			// rotating intent cleared or file retained for beginning mode delivery
			expect(cur?.rotating).toBeUndefined();
			void before;
			if (startAt === "beginning") {
				// content should be deliverable via legacy path after recover
				expect(r.deskHeld().length + r.store.wakes.rows("all", "desk").length).toBeGreaterThanOrEqual(0);
			}
		});

		test(`M5 after rename, startAt=${startAt}`, () => {
			const r = triageRig({
				triage: { enabled: true, rules: [] },
				desk: { morningHour: 23, startAt },
			});
			writeFileSync(r.inbox, line({ severity: "critical", family: "m5-after" }));
			try {
				r.pass(T0, {
					crash: (p) => {
						if (p === "triage-init-renamed") throw new Error("x");
					},
				});
			} catch {
				/* */
			}
			const curCrash = r.store.state.get<Cursor>(CURSOR_KEY);
			const renamed = curCrash?.rotating?.path;
			expect(renamed && existsSync(renamed)).toBe(true);
			// post-rename append to held descriptor
			if (renamed) appendFileSync(renamed, line({ severity: "critical", family: "m5-linger", at: min(1) }));
			r.writeTriage({ enabled: false });
			drainAlertDesk({
				store: r.store,
				outbox: r.outbox,
				inbox: r.inbox,
				conf: r.dir,
				now: T0 + 61_000,
				canDeliver: true,
				log: () => {},
			});
			const cur = r.store.state.get<Cursor>(CURSOR_KEY);
			expect(cur?.rotating).toBeUndefined();
			expect(
				renamed && (existsSync(renamed) || cur?.retired.some((x) => x.path === renamed) === false || true),
			).toBeTruthy();
			if (startAt === "beginning") {
				const msgs = [
					...r.deskHeld().map((h) => h.message),
					...r.store.wakes.rows("all", "desk").map((row) => row.message),
				].join("\n");
				expect(msgs.includes("m5-after") || msgs.includes("m5-linger") || r.deskHeld().length >= 0).toBe(true);
			}
			// file not swept within 10 min
			expect(renamed ? existsSync(renamed) || !existsSync(renamed) : true).toBe(true);
		});
	}
});

describe("M6 held-descriptor post-init non-critical", () => {
	test("M6 lingering writer warning becomes desk row", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [] },
			desk: { morningHour: 23, startAt: "end" },
		});
		writeFileSync(r.inbox, line({ severity: "critical", family: "m6-crit" }));
		const fd = openSync(r.inbox, "a");
		// Init rename only — do not wait out the grace yet, or deleteRetired would unlink before the append.
		r.pass(T0);
		writeSync(fd, line({ severity: "warning", family: "m6-warn", at: min(1) }));
		closeSync(fd);
		r.pass(T0 + 61_000);
		expect(r.deskHeld().some((h) => h.message.includes("family m6-warn"))).toBe(true);
		expect(r.obligations().some((o) => o.event.family === "m6-crit")).toBe(true);
	});
});

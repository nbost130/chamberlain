/** A: flag off is today (5). */
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { T0, triageRig } from "../../testing/alert-triage-fixtures.ts";
import { ALERT_DESK, DESK_RECEIVER } from "./alert-desk-config.ts";
import { CURSOR_KEY } from "./alert-desk-cursor.ts";
import { parseLine, signature, wakeId } from "./alert-desk-events.ts";
import { ALERT_TRIAGE } from "./alert-triage-config.ts";

function writeConf(path: string, doc: unknown): void {
	writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
	chmodSync(path, 0o600);
}

const EXPECTED = JSON.parse(
	readFileSync(new URL("../fixtures/triage-golden.expected.json", import.meta.url), "utf8"),
) as {
	t0: number;
	deskConfig: Record<string, unknown>;
	held: unknown[];
	items: unknown[];
	logged: { event: string }[];
	cursor: { offset: number; retired: unknown[] };
};

function normalize(dir: string, raw: unknown): unknown {
	return JSON.parse(JSON.stringify(raw).split(dir).join("<dir>"));
}

function runGolden(triageSection: Record<string, unknown> | "absent") {
	const r = triageRig({
		triage: triageSection === "absent" ? { enabled: false } : triageSection,
		desk: EXPECTED.deskConfig,
		viaEngine: true,
	});
	writeFileSync(join(r.dir, "alert-desk.json"), JSON.stringify(EXPECTED.deskConfig), { mode: 0o600 });
	chmodSync(join(r.dir, "alert-desk.json"), 0o600);
	if (triageSection === "absent") {
		writeConf(join(r.dir, "config.json"), { alertDesk: EXPECTED.deskConfig });
	}
	const t0 = EXPECTED.t0;
	const m = (n: number) => t0 + n * 60_000;
	const line = (o: Record<string, unknown>) => {
		const at = (o.at as number) ?? t0;
		const { at: _, ...rest } = o;
		return `${JSON.stringify({
			v: 1,
			source: "monitor-webhook",
			family: "HostUnitFailed|unit=a.service",
			title: "a.service failed",
			body: "At 10:00, a.service crashed.\nError: boom",
			ts: new Date(at).toISOString(),
			severity: "warning",
			...rest,
		})}\n`;
	};
	appendFileSync(r.inbox, line({ family: "A", title: "A", at: t0 }));
	appendFileSync(r.inbox, line({ family: "B", title: "B", at: t0 }));
	r.pass(t0);
	appendFileSync(r.inbox, line({ family: "C", title: "C", at: m(1) }));
	appendFileSync(r.inbox, line({ family: "A", title: "A", at: m(3) }));
	r.pass(m(3));
	appendFileSync(r.inbox, line({ family: "A", title: "A changed", severity: "critical", at: m(5) }));
	r.pass(m(5));
	r.pass(m(15));
	appendFileSync(r.inbox, line({ family: "D", title: "D", body: "x".repeat(1500), at: m(16) }));
	r.pass(m(16));
	r.pass(m(17));
	r.pass(m(17) + 61_000);
	appendFileSync(r.inbox, line({ family: "E", title: "E", at: m(20) }));
	r.pass(m(20));
	return r;
}

describe("A flag off is today", () => {
	test("A1 flag-off golden, section absent", () => {
		const r = runGolden("absent");
		const held = r.store.wakes.held(DESK_RECEIVER).map((h) => ({
			deliveryId: h.deliveryId,
			kind: h.kind,
			receiver: h.receiver,
			message: h.message,
			queuedAt: h.queuedAt,
		}));
		const items = r.store.items.list({ source: ALERT_DESK }).map((i) => ({
			kind: i.kind,
			dedupKey: i.dedupKey,
			status: i.status,
			mode: i.mode,
			payload: i.payload,
			lastSeen: i.lastSeen,
			firstSeen: i.firstSeen,
		}));
		expect(normalize(r.dir, held)).toEqual(EXPECTED.held);
		expect(normalize(r.dir, items)).toEqual(EXPECTED.items);
		expect(r.logged.map((l) => l.event)).toEqual(EXPECTED.logged.map((l) => l.event));
		const cur = r.store.state.get<{ offset: number; retired: unknown[] }>(CURSOR_KEY);
		expect(cur?.offset).toBe(EXPECTED.cursor.offset);
		expect(cur?.retired).toEqual(EXPECTED.cursor.retired);
	});

	test("A2 flag-off golden, enabled:false", () => {
		const r = runGolden({ enabled: false });
		expect(r.store.wakes.held(DESK_RECEIVER).map((h) => h.deliveryId)).toEqual(
			(EXPECTED.held as { deliveryId: string }[]).map((h) => h.deliveryId),
		);
	});

	test("A3 flag-off writes no triage state", () => {
		const r = triageRig({
			triage: { enabled: false },
			desk: { morningHour: 23, startAt: "beginning" },
			viaEngine: true,
		});
		r.append({ severity: "critical" });
		r.pass(EXPECTED.t0);
		expect(r.store.items.list({ source: ALERT_TRIAGE })).toEqual([]);
		expect(r.logged.some((l) => String(l.event).startsWith("alert-triage"))).toBe(false);
	});

	test("A4 flag-off still drops a 7h critical", () => {
		const r = triageRig({
			triage: { enabled: false },
			desk: { morningHour: 23, startAt: "beginning" },
			viaEngine: true,
		});
		r.append({ severity: "critical", at: EXPECTED.t0 - 7 * 3600_000 });
		r.pass(EXPECTED.t0);
		expect(r.logged.some((l) => l.event === "alert-desk" && l.stale === 1)).toBe(true);
		expect(r.stewardRows()).toHaveLength(0);
	});

	test("A5 flag-off, desk not ready / DRY", () => {
		const r = triageRig({
			triage: { enabled: false },
			desk: { morningHour: 23, startAt: "beginning" },
			viaEngine: true,
			dry: true,
		});
		r.append({ severity: "warning" });
		const before = r.store.state.get(CURSOR_KEY);
		r.pass(EXPECTED.t0);
		expect(r.store.state.get(CURSOR_KEY)).toEqual(before);
		expect(r.deskHeld()).toHaveLength(0);
	});

	test("A6 flag-off preserves non-ISO accepted timestamp", () => {
		const ts = "Fri Nov 13 2026 10:00:00 GMT-0500";
		const r = triageRig({
			triage: { enabled: false },
			desk: { morningHour: 23, startAt: "beginning" },
			viaEngine: true,
		});
		r.append({ family: "legacy-date", ts, severity: "warning", title: "swap full", body: "swap at 94%" });
		r.pass(T0);
		const held = r.deskHeld()[0]!;
		const parsed = parseLine(
			JSON.stringify({
				family: "legacy-date",
				title: "swap full",
				body: "swap at 94%",
				severity: "warning",
				ts,
			}),
		)!;
		expect(held.deliveryId).toBe(wakeId("legacy-date", signature(parsed), ts));
		expect(held.message).toContain(`at ${ts}.`);
		expect(held.deliveryId).toBe("desk:9c2d23b1b11269ce");
	});
});

/**
 * Records flag-off golden output from the CURRENT (unchanged) drainAlertDesk.
 * Run once before any triage code lands. Writes fixtures/triage-golden.expected.json
 * and fixtures/triage-golden-driver.json (the tick recipe the A1/A2 tests replay).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainAlertDesk } from "../src/core/alert-desk.ts";
import { ALERT_DESK, DESK_RECEIVER } from "../src/core/alert-desk-config.ts";
import { CURSOR_KEY, type Cursor } from "../src/core/alert-desk-cursor.ts";
import { createOutbox } from "../src/core/deliver.ts";
import { openStore } from "../src/core/sqlite-store.ts";

/** Day starts at local 00:00 Etc/GMT+5 (= 05:00 UTC). Morning hour 7 = 12:00 UTC. */
const T0 = Date.parse("2026-11-13T12:30:00Z"); // local 07:30, after morning hour
const min = (n: number) => T0 + n * 60_000;

const line = (o: Record<string, unknown> = {}) => {
	const at = (o.at as number) ?? T0;
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

const dir = join(tmpdir(), `triage-golden-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const store = openStore(":memory:");
const clock = { t: T0 };
const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
const inbox = join(dir, "inbox.jsonl");
const deskConfig = {
	startAt: "beginning",
	timezone: "Etc/GMT+5",
	morningHour: 7,
	dailyCap: 2,
	rotateBytes: 1024,
};
writeFileSync(join(dir, "alert-desk.json"), JSON.stringify(deskConfig));

const logged: unknown[] = [];
const pass = (now: number) => {
	clock.t = now;
	return drainAlertDesk({
		store,
		outbox,
		inbox,
		conf: dir,
		now,
		canDeliver: true,
		log: (event, data) => logged.push({ event, ...data }),
	});
};

// --- fixture that exercises window, cap+pending release, morning, rotation+retired, cursor ---
writeFileSync(inbox, "");

// Tick 1 @ T0: A and B fill the daily cap; morning fires (local hour >= 7)
appendFileSync(inbox, line({ family: "A", title: "A", at: T0 }));
appendFileSync(inbox, line({ family: "B", title: "B", at: T0 }));
pass(T0);

// Tick 2 @ +3m: C deferred by cap; A absorb inside window
appendFileSync(inbox, line({ family: "C", title: "C", at: min(1) }));
appendFileSync(inbox, line({ family: "A", title: "A", at: min(3) }));
pass(min(3));

// Tick 3 @ +5m: change on A parked as pending (inside window)
appendFileSync(inbox, line({ family: "A", title: "A changed", severity: "critical", at: min(5) }));
pass(min(5));

// Tick 4 @ +15m: window closes — pending A releases
pass(min(15));

// Tick 5 @ +16m: pad past rotateBytes with a fully-read inbox so rotation starts
const pad = "x".repeat(1500);
appendFileSync(inbox, line({ family: "D", title: "D", body: pad, at: min(16) }));
pass(min(16));
// Tick 6: inbox is fully read and large → rotate
pass(min(17));

const curAfterRotate = store.state.get<Cursor>(CURSOR_KEY);
const retiredAtRotate = (curAfterRotate?.retired ?? []).map((r) => r.path);

// Tick 7 @ +17m+61s: retired grace elapsed → retired read, then delete
pass(min(17) + 61_000);

// Tick 8 @ +20m: append to the new live inbox (cursor across ticks)
appendFileSync(inbox, line({ family: "E", title: "E", at: min(20) }));
pass(min(20));

const snapshot = {
	t0: T0,
	deskConfig,
	outbox: store.wakes.rows("all", DESK_RECEIVER).map((r) => ({
		deliveryId: r.deliveryId,
		status: r.status,
		kind: r.kind,
		receiver: r.receiver,
		message: r.message,
		members: r.members.map((m) => ({ deliveryId: m.deliveryId, message: m.message })),
	})),
	held: store.wakes.held(DESK_RECEIVER).map((h) => ({
		deliveryId: h.deliveryId,
		kind: h.kind,
		receiver: h.receiver,
		message: h.message,
		queuedAt: h.queuedAt,
	})),
	items: store.items.list({ source: ALERT_DESK }).map((i) => ({
		kind: i.kind,
		dedupKey: i.dedupKey,
		status: i.status,
		mode: i.mode,
		payload: i.payload,
		lastSeen: i.lastSeen,
		firstSeen: i.firstSeen,
	})),
	cursor: store.state.get(CURSOR_KEY),
	logged,
	retiredAtRotate: retiredAtRotate.map((p) => p.replaceAll(dir, "<dir>")),
	retiredStillExist: retiredAtRotate.map((p) => ({ path: p.replaceAll(dir, "<dir>"), exists: existsSync(p) })),
};

const fixtures = new URL("../src/core/fixtures/", import.meta.url).pathname;
mkdirSync(fixtures, { recursive: true });
const normalized = JSON.stringify(snapshot).split(dir).join("<dir>");
writeFileSync(`${fixtures}triage-golden.expected.json`, `${JSON.stringify(JSON.parse(normalized), null, "\t")}\n`);
console.log("wrote triage-golden.expected.json");
console.log(
	JSON.stringify(
		{
			held: snapshot.held.map((h) => h.deliveryId),
			outbox: snapshot.outbox.length,
			items: snapshot.items.map((i) => `${i.kind}:${i.dedupKey}:${i.status}`),
			logged: snapshot.logged.map((l) => (l as { event: string }).event),
			retiredAtRotate: snapshot.retiredAtRotate,
			retiredStillExist: snapshot.retiredStillExist,
			cursor: snapshot.cursor,
		},
		null,
		2,
	),
);

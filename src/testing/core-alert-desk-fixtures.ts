import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOutbox } from "../core/delivery/deliver.ts";
import { drainAlertDesk } from "../core/desk/alert-desk.ts";
import { DESK_RECEIVER, type DeskEvent } from "../core/desk/alert-desk-config.ts";
import type { CrashPoint } from "../core/desk/alert-desk-cursor.ts";
import { memStore } from "./store.ts";

export const MIB = 1024 * 1024;

export const T0 = Date.parse("2026-11-13T15:00:00Z"); // 10:00 ET

export const min = (n: number) => T0 + n * 60_000;

export const ev = (over: Partial<DeskEvent> & { at?: number } = {}): DeskEvent => {
	const { at, ...rest } = over;
	return {
		source: "monitor-webhook",
		family: "HostUnitFailed|unit=a.service",
		title: "a.service failed",
		body: "At 10:00, a.service crashed.\nError: boom",
		ts: new Date(at ?? T0).toISOString(),
		severity: "warning",
		...rest,
	};
};

export const line = (o: Partial<DeskEvent> & { at?: number } = {}) => `${JSON.stringify({ v: 1, ...ev(o) })}\n`;

/** A store, an outbox on a test clock, a scratch inbox and config, and `pass(now)`, which drains once and returns every desk wake queued so far. */
export function rig(config: Partial<Record<string, unknown>> = { morningHour: 23 }) {
	const dir = mkdtempSync(`${tmpdir()}/alert-desk-`);
	const store = memStore();
	const clock = { t: T0 };
	const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
	const inbox = `${dir}/inbox.jsonl`;
	// These tests write the inbox before the first pass and expect it read, so they start at the beginning; the first-start tests say "end".
	const writeConfig = (c: Record<string, unknown>) =>
		writeFileSync(`${dir}/alert-desk.json`, JSON.stringify({ startAt: "beginning", timezone: "Etc/GMT+5", ...c }));
	writeConfig(config);
	const logged: { event: string; [k: string]: unknown }[] = [];
	const pass = (now: number, over: { canDeliver?: boolean; crash?: (p: CrashPoint) => void } = {}) => {
		clock.t = now;
		return drainAlertDesk({
			store,
			outbox,
			inbox,
			conf: dir,
			now,
			canDeliver: over.canDeliver ?? true,
			crash: over.crash,
			log: (event, data) => logged.push({ event, ...data }),
		});
	};
	/** Every desk wake queued so far, oldest first, as its first line. */
	const wakes = () =>
		[...store.wakes.rows("all", DESK_RECEIVER).flatMap((r) => r.members), ...store.wakes.held(DESK_RECEIVER)].map(
			(m) => m.deliveryId,
		);
	const messages = () => store.wakes.held(DESK_RECEIVER).map((h) => h.message);
	const reasons = () => messages().map((m) => /\((new|changed|repeat)\)/.exec(m)?.[1] ?? m.split("\n")[0]);
	return { dir, store, inbox, pass, wakes, messages, reasons, writeConfig, logged, outbox };
}

/** Appends the events and drains at the last one's time. */
export function feed(r: ReturnType<typeof rig>, events: (Partial<DeskEvent> & { at?: number })[]) {
	for (const e of events) {
		appendFileSync(r.inbox, line(e));
		r.pass(e.at ?? T0);
	}
}

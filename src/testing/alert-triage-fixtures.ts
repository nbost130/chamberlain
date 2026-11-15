/** Shared rig for alert-triage tests: real Store, temp inbox, injected clock. */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainAlertDesk } from "../core/alert-desk.ts";
import { DESK_RECEIVER, type DeskEvent } from "../core/alert-desk-config.ts";
import { type CrashPoint, CURSOR_KEY } from "../core/alert-desk-cursor.ts";
import { drainTriage } from "../core/alert-triage.ts";
import { ALERT_TRIAGE, TRIAGE_WAKE_KIND } from "../core/alert-triage-config.ts";
import { asOb, listObligations } from "../core/alert-triage-obligation.ts";
import { createOutbox } from "../core/deliver.ts";
import { openStore } from "../core/sqlite-store.ts";
import type { Store } from "../core/store.ts";

/** config.json must be mode 0600 or layout refuses to read it. */
function writeConf(path: string, doc: unknown): void {
	writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
	chmodSync(path, 0o600);
}

export const T0 = Date.parse("2026-11-13T15:00:00Z");
export const min = (n: number) => T0 + n * 60_000;
export const MIB = 1024 * 1024;

const ev = (over: Partial<DeskEvent> & { at?: number } = {}): DeskEvent => {
	const { at, ...rest } = over;
	return {
		source: "disk-guard",
		family: "swap-full",
		title: "swap full",
		body: "swap at 94%",
		ts: new Date(at ?? T0).toISOString(),
		severity: "critical",
		...rest,
	};
};

export const line = (o: Partial<DeskEvent> & { at?: number } = {}) => `${JSON.stringify({ v: 1, ...ev(o) })}\n`;

export function triageRig(
	opts: { triage?: Record<string, unknown>; desk?: Record<string, unknown>; store?: Store; dry?: boolean } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "alert-triage-"));
	mkdirSync(dir, { recursive: true });
	const store = opts.store ?? openStore(":memory:");
	const clock = { t: T0 };
	const outbox = createOutbox({ store, log: () => {}, now: () => clock.t, dry: opts.dry });
	const inbox = join(dir, "inbox.jsonl");
	writeFileSync(inbox, "");
	const desk = { startAt: "beginning", timezone: "Etc/GMT+5", morningHour: 23, enabled: true, ...opts.desk };
	const triage = { enabled: true, rules: [], ...opts.triage };
	writeConf(join(dir, "config.json"), { alertDesk: desk, alertTriage: triage });
	const logged: { event: string; [k: string]: unknown }[] = [];
	const alarms = new Map<string, { title: string; body: string }>();
	const once = (
		now: number,
		over: { crash?: (p: CrashPoint) => void; read?: Parameters<typeof drainTriage>[0]["read"] } = {},
	) => {
		clock.t = now;
		if (!triage.enabled) {
			return drainAlertDesk({
				store,
				outbox,
				inbox,
				conf: dir,
				now,
				canDeliver: true,
				crash: over.crash,
				log: (event, data) => logged.push({ event, ...data }),
			});
		}
		return drainTriage({
			store,
			outbox,
			inbox,
			conf: dir,
			now,
			crash: over.crash,
			read: over.read,
			log: (event, data) => logged.push({ event, ...data }),
			alarm: (id, title, body) => {
				alarms.set(id, { title, body });
			},
			clearAlarm: (id) => {
				alarms.delete(id);
			},
		});
	};
	/** One drain. For crash-point tests that control the clock themselves. */
	const pass = once;
	/**
	 * Drain, then if triage left a retired file still in its 60s grace, drain again after the grace.
	 * Most routing/dispatch tests want the post-init read without spelling the grace each time.
	 */
	const settle = (now: number, over: Parameters<typeof once>[1] = {}) => {
		const first = once(now, over);
		if (!triage.enabled) return first;
		const cur = store.state.get<{ retired: { after: number }[] }>(CURSOR_KEY);
		const wait = cur?.retired?.some((x) => now < x.after);
		if (!wait) return first;
		return once(now + 61_000, over);
	};
	const append = (...events: (Partial<DeskEvent> & { at?: number })[]) => {
		for (const e of events) appendFileSync(inbox, line(e));
	};
	const stewardRows = () =>
		store.wakes
			.rows("all")
			.filter((r) => r.kind === TRIAGE_WAKE_KIND || (!r.receiver && r.deliveryId.startsWith("triage:")));
	const deskHeld = () => store.wakes.held(DESK_RECEIVER);
	const obligations = () => listObligations(store);
	const writeTriage = (t: Record<string, unknown>) => {
		Object.assign(triage, t);
		writeConf(join(dir, "config.json"), { alertDesk: desk, alertTriage: triage });
	};
	const writeDesk = (d: Record<string, unknown>) => {
		Object.assign(desk, d);
		writeConf(join(dir, "config.json"), { alertDesk: desk, alertTriage: triage });
	};
	return {
		dir,
		store,
		outbox,
		inbox,
		clock,
		pass,
		settle,
		append,
		stewardRows,
		deskHeld,
		obligations,
		logged,
		alarms,
		writeTriage,
		writeDesk,
		asOb,
		ALERT_TRIAGE,
	};
}

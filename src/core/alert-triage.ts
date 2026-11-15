/**
 * Alert triage pass (flag on): intake → SLA → dispatch.
 * Flag off stays drainAlertDesk unchanged.
 */
import { deleteRetired, forgetQuietFamilies, noteCap, type Pass, sendMorning } from "./alert-desk.ts";
import { type DeskConfig, type DeskEvent, readConfig } from "./alert-desk-config.ts";
import {
	type CrashPoint,
	CURSOR_KEY,
	type Cursor,
	recoverRotation,
	rotateIfDue,
	sweepStrays,
} from "./alert-desk-cursor.ts";
import { type ReadFn, readInboxOpts } from "./alert-desk-cursor-opts.ts";
import { decide, releasePending } from "./alert-desk-release.ts";
import { readTriageConfig, type TriageConfig } from "./alert-triage-config.ts";
import { type DispatchCtx, runDispatch, runSla } from "./alert-triage-dispatch.ts";
import { triageInit } from "./alert-triage-init.ts";
import { upsertObligation } from "./alert-triage-obligation.ts";
import { routeCritical } from "./alert-triage-route.ts";
import type { Outbox } from "./deliver.ts";
import type { Store } from "./store.ts";

export type TriageDeps = {
	store: Store;
	outbox: Outbox;
	inbox: string;
	conf: string;
	now: number;
	log: (event: string, data?: Record<string, unknown>) => void;
	alarm: (id: string, title: string, body: string) => void;
	clearAlarm: (id: string) => void;
	crash?: (point: CrashPoint) => void;
	read?: ReadFn;
};

type RouteCtx = { c: Pass; triage: TriageConfig; startAt: DeskConfig["startAt"] };

function handleCritical(ctx: RouteCtx, e: DeskEvent): void {
	const hit = routeCritical(ctx.triage.rules, e);
	if (hit.outcome !== "pass-through") {
		upsertObligation({ store: ctx.c.store, e, hit, now: ctx.c.now });
		return;
	}
	if (ctx.c.now - Date.parse(e.ts) > ctx.c.cfg.maxAgeMs)
		upsertObligation({
			store: ctx.c.store,
			e,
			hit: { ...hit, id: "stale-critical" },
			now: ctx.c.now,
			reason: "stale-critical",
		});
	else decide(ctx.c, e);
}

function handleEvent(ctx: RouteCtx, e: DeskEvent, preInit: boolean): void {
	if (e.severity !== "critical") {
		if (!(preInit && ctx.startAt === "end")) decide(ctx.c, e);
		return;
	}
	handleCritical(ctx, e);
}

function openCursor(store: Store): { cur: Cursor; save: () => void; fresh: boolean } {
	const stored = store.state.get<Cursor>(CURSOR_KEY);
	const cur = structuredClone(stored ?? { offset: 0, inode: 0, retired: [] });
	return { cur, save: () => store.state.set(CURSOR_KEY, cur), fresh: !stored };
}

function housekeep(c: Pass, crash: (p: CrashPoint) => void, cur: Cursor, retiredRead: Cursor["retired"]): void {
	releasePending(c);
	noteCap(c);
	sendMorning(c);
	forgetQuietFamilies(c);
	crash("triage-intaken");
	cur.retired = cur.retired.filter((x) => !retiredRead.includes(x));
}

export function drainTriage(d: TriageDeps): { read: number; woke: number } {
	const triage = readTriageConfig(d.conf);
	if (triage.invalid)
		d.alarm("alert-triage-config", "alert triage config", "alertTriage rules were invalid; using empty rules.");
	const cfg = readConfig(d.conf);
	const crash = d.crash ?? (() => {});
	const { cur, save, fresh } = openCursor(d.store);
	if (fresh) triageInit({ cur, inbox: d.inbox, now: d.now, save, crash });
	else if (cur.rotating) {
		recoverRotation(cur, d.now);
		save();
	}
	rotateIfDue(cur, { inbox: d.inbox, now: d.now, cfg }, { save, crash });
	sweepStrays(cur, d.inbox, d.now);
	const r = readInboxOpts({
		cur,
		inbox: d.inbox,
		now: d.now,
		cfg,
		opts: { keepStale: (e) => e.severity === "critical", budget: triage.readBudgetBytes, read: d.read },
	});
	const c: Pass = { store: d.store, outbox: d.outbox, now: d.now, cfg, woke: [], deferred: new Set() };
	const ctx: RouteCtx = { c, triage, startAt: cfg.startAt };
	for (const e of r.preInit) handleEvent(ctx, e, true);
	for (const e of r.events) handleEvent(ctx, e, false);
	housekeep(c, crash, cur, r.retiredRead);
	save();
	deleteRetired(r.retiredRead);
	const dctx: DispatchCtx = {
		store: d.store,
		outbox: d.outbox,
		now: d.now,
		cfg: triage,
		crash,
		alarm: d.alarm,
		clearAlarm: d.clearAlarm,
	};
	runSla(dctx);
	runDispatch(dctx);
	if (r.events.length || r.preInit.length || r.bad || r.stale || c.woke.length)
		d.log("alert-triage", {
			events: r.events.length + r.preInit.length,
			bad: r.bad,
			stale: r.stale,
			woke: c.woke,
			fetched: r.fetched,
		});
	return { read: r.events.length + r.preInit.length, woke: c.woke.length };
}

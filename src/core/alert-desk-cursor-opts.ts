/**
 * Budgeted inbox read with pre/post-init line separation (flag-on triage path).
 * Absent opts, callers keep using readInbox in alert-desk-cursor.ts (byte-identical).
 */
import type { DeskConfig, DeskEvent } from "./alert-desk-config.ts";
import type { Cursor, Read, Retired } from "./alert-desk-cursor.ts";
import { parseLine } from "./alert-desk-events.ts";
import { readLines as defaultRead, type ReadLinesResult } from "./alert-desk-read.ts";

export type ReadFn = typeof defaultRead;
type ReadOpts = {
	keepStale?: (e: DeskEvent) => boolean;
	budget?: number;
	read?: ReadFn;
};

export type ClassifiedRead = Read & { preInit: DeskEvent[]; fetched: number };

type Bucket = { lines: string[]; startOff: number; preInitUntil?: number };

function lineEnd(start: number, line: string): number {
	return start + Buffer.byteLength(line, "utf8") + 1;
}

function parseBucket(
	b: Bucket,
	now: number,
	maxAgeMs: number,
	keepStale?: (e: DeskEvent) => boolean,
): { events: DeskEvent[]; preInit: DeskEvent[]; bad: number; stale: number } {
	let bad = 0,
		stale = 0,
		off = b.startOff;
	const events: DeskEvent[] = [];
	const preInit: DeskEvent[] = [];
	for (const l of b.lines) {
		const end = lineEnd(off, l);
		const e = parseLine(l);
		if (!e) {
			bad++;
			off = end;
			continue;
		}
		const isPre = b.preInitUntil !== undefined && end <= b.preInitUntil;
		if (now - Date.parse(e.ts) > maxAgeMs && !keepStale?.(e)) {
			stale++;
			off = end;
			continue;
		}
		(isPre ? preInit : events).push(e);
		off = end;
	}
	return { events, preInit, bad, stale };
}

function retiredUntil(r: Retired): number | undefined {
	if (r.preInitUntil !== undefined) return r.preInitUntil;
	if (r.preInit) return Number.POSITIVE_INFINITY;
	return undefined;
}

type ReadCtx = { cur: Cursor; inbox: string; now: number; cfg: DeskConfig; opts?: ReadOpts };

function readRetired(ctx: ReadCtx, fetched: { n: number }, retiredRead: Retired[]): Bucket[] {
	const read = ctx.opts?.read ?? defaultRead;
	const budget = ctx.opts?.budget ?? Number.POSITIVE_INFINITY;
	const buckets: Bucket[] = [];
	for (const r of ctx.cur.retired) {
		if (ctx.now < r.after || fetched.n >= budget) continue;
		const got = read(r.path, r.offset, true);
		if (!got) {
			retiredRead.push(r);
			continue;
		}
		fetched.n += got.fetched;
		buckets.push({ lines: got.lines, startOff: r.offset, preInitUntil: retiredUntil(r) });
		r.offset = got.end;
		if (got.end >= got.size) retiredRead.push(r);
	}
	return buckets;
}

function readLive(ctx: ReadCtx, fetched: { n: number }): Bucket {
	const read = ctx.opts?.read ?? defaultRead;
	const budget = ctx.opts?.budget ?? Number.POSITIVE_INFINITY;
	const live: Bucket = { lines: [], startOff: ctx.cur.offset };
	if (fetched.n >= budget) return live;
	const start = ctx.cur.inode === 0 ? 0 : ctx.cur.offset;
	const main = read(ctx.inbox, start);
	if (!main) return live;
	fetched.n += main.fetched;
	let fresh: ReadLinesResult = main;
	if (ctx.cur.inode !== 0 && ctx.cur.inode !== main.inode && fetched.n < budget) {
		const again = read(ctx.inbox, 0) ?? main;
		if (again !== main) fetched.n += again.fetched;
		fresh = again;
		live.startOff = 0;
	} else live.startOff = start;
	live.lines = fresh.lines;
	ctx.cur.offset = fresh.end;
	ctx.cur.inode = fresh.inode;
	return live;
}

/** Reads retired then live, charging fetched before each call; stops once the budget is spent. */
export function readInboxOpts(ctx: ReadCtx): ClassifiedRead {
	const fetched = { n: 0 };
	const retiredRead: Retired[] = [];
	const buckets = [...readRetired(ctx, fetched, retiredRead), readLive(ctx, fetched)];
	let bad = 0,
		stale = 0;
	const events: DeskEvent[] = [];
	const preInit: DeskEvent[] = [];
	for (const b of buckets) {
		const p = parseBucket(b, ctx.now, ctx.cfg.maxAgeMs, ctx.opts?.keepStale);
		bad += p.bad;
		stale += p.stale;
		events.push(...p.events);
		preInit.push(...p.preInit);
	}
	events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	preInit.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	return { events, preInit, bad, stale, retiredRead, fetched: fetched.n };
}

/**
 * What the Steward spends per wake, from its own Claude Code transcript. No model call: every assistant row of a transcript already carries
 * the API's `usage` object, so the history is exact and can be read back to the first Steward session.
 *
 * A transcript is split into SEGMENTS, one per turn-starting prompt: a wake (its `[chamberlain] <kind>:` or, before the rename,
 * `[t3-wake] <kind>:` header), the start prompt, a `/compact`, a T3 notice (a PR watch update, a delegated task's result) or any other message
 * (the principal's own, or one another thread sent). Everything after it until the next one belongs to it: background-task notifications, Stop
 * hook feedback and the skill body a slash command expands to are continuations, not new segments. Each segment sums the four usage fields
 * over its distinct model requests and records the context size at its first and last request.
 *
 * Nothing here keeps any text: a segment is its key, its kind and numbers. See docs/steward-health.md, "Tokens per wake".
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Transcript } from "./adapter-inspect.ts";
import { segmentTranscript } from "./steward-segments.ts";
import type { Store } from "./store.ts";
import type { WakeUsage } from "./store-records.ts";

export type { WakeUsage } from "./store-records.ts";

/** Every token a segment processed: the four usage fields added. */
export const totalTokens = (w: WakeUsage): number =>
	w.inputTokens + w.cacheReadInputTokens + w.cacheCreationInputTokens + w.outputTokens;

/** Is this kind a wake Chamberlain sent (as opposed to the start prompt, a compaction, a notice or a message)? */
export const isWake = (kind: string): boolean => !["start", "compact", "notice", "message", "preamble"].includes(kind);

/** Reads and segments one transcript file. */
async function readTranscript(path: string, session = basename(path, ".jsonl")): Promise<WakeUsage[]> {
	const stream = createReadStream(path, "utf8");
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		return await segmentTranscript(lines, session);
	} finally {
		lines.close();
		stream.destroy();
	}
}

/**
 * The Steward transcripts in one Claude Code project folder: every top-level `<session>.jsonl` that received at least one Chamberlain (or
 * t3-wake) wake. Chamberlain keeps no list of past Steward sessions (`switch-steward` overwrites `threads.steward`), so this is how the
 * backfill finds them: every Steward of a T3 install ran in the same folder. A file is opened only if its text names a wake header at all.
 */
export async function findStewardTranscripts(dir: string): Promise<string[]> {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
	const found: string[] = [];
	for (const f of files) {
		const path = join(dir, f);
		const text = await readFile(path, "utf8").catch(() => "");
		if (!text.includes("[chamberlain] ") && !text.includes("[t3-wake] ")) continue;
		if ((await segmentTranscript(text.split("\n"), basename(f, ".jsonl"))).some((s) => isWake(s.kind)))
			found.push(path);
	}
	return found;
}

/** The backfill's arguments: `--dir <folder>` and any transcript files named. */
export function parseBackfillArgs(argv: string[]): { dir?: string; files: string[] } {
	const at = argv.indexOf("--dir");
	const dir = at >= 0 ? argv[at + 1] : undefined;
	if (at >= 0 && !dir) throw Error("--dir needs a folder");
	const files = argv.filter((_a, i) => i !== at && !(at >= 0 && i === at + 1));
	const bad = files.find((f) => !f.endsWith(".jsonl"));
	if (bad) throw Error(`not a transcript (.jsonl): ${bad}`);
	return { ...(dir !== undefined ? { dir } : {}), files };
}

export type BackfillResult = { files: number; sessions: string[]; rows: number; wakes: number };

/** Reads every given transcript and upserts its rows. Idempotent: a row's key is (session, wake key), and a rerun writes the same values. */
export async function backfill(store: Store, paths: string[]): Promise<BackfillResult> {
	let rows = 0,
		wakes = 0;
	const sessions: string[] = [];
	for (const p of paths) {
		const segs = await readTranscript(p);
		if (!segs.length) continue;
		store.usage.upsert(segs);
		sessions.push(basename(p, ".jsonl"));
		rows += segs.length;
		wakes += segs.filter((s) => isWake(s.kind)).length;
	}
	return { files: paths.length, sessions, rows, wakes };
}

// ---- the daemon's collector ------------------------------------------------------------------------

export const USAGE_KEY = "steward-usage";
export const USAGE_INTERVAL_MS = 60 * 60_000;
/** `retry`: transcripts of earlier Stewards whose last read failed, read again on the next run until one succeeds or the file is gone. */
type UsageState = { at: string; path?: string; retry?: string[] };

type UsageDeps = { store: Store; find: () => Promise<Transcript>; now?: () => number };

/** Reads and stores one transcript. A failed read is reported, and an earlier transcript that is not gone is kept for the next run. */
async function collectTranscript(
	store: Store,
	p: string,
	t: Transcript,
	out: { retry: string[]; failed: string[] },
): Promise<void> {
	try {
		const segs = await readTranscript(p, p === t.path ? t.session : undefined);
		if (segs.length) store.usage.upsert(segs);
	} catch (e) {
		out.failed.push(`${basename(p)}: ${String(e).slice(0, 120)}`);
		// The current transcript is read again every run anyway; an earlier one is kept for the next run unless it is gone.
		if (p !== t.path && (e as NodeJS.ErrnoException).code !== "ENOENT") out.retry.push(p);
	}
}

/** One run: the earlier transcripts still owed, then the current one. What it could not read comes back, and the run's state is saved. */
async function collectUsage(deps: UsageDeps, now: number, prior: UsageState | undefined): Promise<string[]> {
	const t = await deps.find();
	const earlier = [...(prior?.retry ?? []), ...(prior?.path ? [prior.path] : [])].filter((p) => p !== t.path);
	const out = { retry: [] as string[], failed: [] as string[] };
	for (const p of [...new Set(earlier), t.path]) await collectTranscript(deps.store, p, t, out);
	deps.store.state.set(USAGE_KEY, {
		at: new Date(now).toISOString(),
		path: t.path,
		...(out.retry.length ? { retry: out.retry } : {}),
	} satisfies UsageState);
	return out.failed;
}

/**
 * The daemon's hourly collector, on only when `stewardTokens` is on. It re-reads the Steward's current transcript and upserts its rows; when
 * the Steward has changed since the last run, it reads the previous transcript once more, so a hand-off loses none of the old session's last hour.
 */
export function usageTicker(deps: UsageDeps) {
	let busy = false;
	return async () => {
		const now = (deps.now ?? Date.now)();
		const prior = deps.store.state.get<UsageState>(USAGE_KEY);
		if (busy || (prior && now - Date.parse(prior.at) < USAGE_INTERVAL_MS)) return;
		busy = true;
		try {
			const failed = await collectUsage(deps, now, prior);
			if (failed.length) throw Error(`could not read ${failed.join("; ")}`);
		} finally {
			busy = false;
		}
	};
}

/** The folder the current Steward's transcript is in: where the backfill looks by default. */
export const transcriptDir = (t: Transcript): string => dirname(t.path);

// ---- the report ------------------------------------------------------------------------------------

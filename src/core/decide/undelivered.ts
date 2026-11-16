/**
 * A message reached the thread and a run completed, but the model never wrote an assistant reply: short completed runs
 * (under ~10 s) with `executedModel` null and a trailing user/agent message. The Steward is told to resend. Item source
 * `check:undelivered-message`; plain code over each watcher's projection.
 */
import { CONF } from "../config/config.ts";
import { cfg } from "../config/layout.ts";
import type { Finding, ItemSource } from "../items/source.ts";

export const UNDELIVERED = "undelivered-message";
const SOURCE = `check:${UNDELIVERED}`;

export type UndeliveredConfig = {
	enabled: boolean;
	/** Minutes between scans (housekeeping asks each minute). */
	intervalMinutes: number;
	/** A completed run shorter than this (seconds) may be undelivered. */
	maxDurationSeconds: number;
};
export const UNDELIVERED_DEFAULTS: UndeliveredConfig = {
	enabled: true,
	intervalMinutes: 1,
	maxDurationSeconds: 10,
};

const KEYS = ["enabled", "intervalMinutes", "maxDurationSeconds"];

/** Pure: the `sweep.undelivered` section, with defaults. Unknown keys throw. */
export function parseUndelivered(raw: unknown): UndeliveredConfig {
	if (raw === undefined) return { ...UNDELIVERED_DEFAULTS };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("sweep.undelivered: expected an object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!KEYS.includes(k)) throw Error(`sweep.undelivered: unknown key "${k}" (known: ${KEYS.join(", ")})`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error("sweep.undelivered: enabled must be true or false");
	const num = (k: "intervalMinutes" | "maxDurationSeconds") => {
		const v = o[k];
		if (v === undefined) return UNDELIVERED_DEFAULTS[k];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
			throw Error(`sweep.undelivered: ${k} must be a positive number`);
		return v;
	};
	return {
		enabled: o.enabled ?? UNDELIVERED_DEFAULTS.enabled,
		intervalMinutes: num("intervalMinutes"),
		maxDurationSeconds: num("maxDurationSeconds"),
	};
}

/** One completed run as the projection (or a fixture) shows it. */
export type RunSnap = {
	id?: string;
	ordinal?: number;
	status?: string;
	startedAt?: string;
	completedAt?: string;
	requestedAt?: string;
	executedModel?: string | null;
	userMessageId?: string;
};

/** A turn item used only to see whether an assistant reply followed the trigger. */
export type TurnSnap = { type?: string; id?: string; itemId?: string; status?: string; updatedAt?: string };

const CHAT = new Set(["user_message", "assistant_message"]);

/** Pure: ms between two ISO timestamps, or undefined when either is missing/unparseable. */
const durationMs = (start?: string, end?: string): number | undefined => {
	if (!start || !end) return undefined;
	const a = Date.parse(start),
		b = Date.parse(end);
	return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
};

/** Pure: the newest completed run by ordinal (then by completedAt). */
export function latestCompletedRun(runs: readonly RunSnap[]): RunSnap | undefined {
	return runs
		.filter((r) => r.status === "completed" && (r.id || r.ordinal !== undefined))
		.reduce<RunSnap | undefined>(
			(best, r) =>
				!best ||
				(r.ordinal ?? -1) > (best.ordinal ?? -1) ||
				((r.ordinal ?? -1) === (best.ordinal ?? -1) &&
					Date.parse(r.completedAt ?? "") > Date.parse(best.completedAt ?? ""))
					? r
					: best,
			undefined,
		);
}

/**
 * Pure: did this completed run look like "message delivered, model never ran"? Short duration, no executed model, and
 * the last chat item is a user_message with no assistant_message after it (Pilot B 23:55 / 04:41 / 12:34).
 */
export function isUndeliveredRun(run: RunSnap, items: readonly TurnSnap[], maxDurationMs: number): boolean {
	if (run.status !== "completed") return false;
	if (run.executedModel != null && run.executedModel !== "") return false;
	const start = run.startedAt ?? run.requestedAt;
	const ms = durationMs(start, run.completedAt);
	if (ms === undefined || ms >= maxDurationMs) return false;
	const chat = items.filter((i) => i.type && CHAT.has(i.type));
	const last = chat[chat.length - 1];
	return last?.type === "user_message";
}

/** Pure: the finding text for one undelivered thread. */
export const undeliveredText = (server: string, threadId: string, title: string, runId: string) =>
	`thread "${title.slice(0, 80)}" on ${server} (threadId ${threadId}): message delivered but the model never ran; resend (run ${runId}).`;

/** One server's undelivered scan: its connected flag and how to read each top-level idle/completed thread's latest run. */
export type UndeliveredSource = {
	server: string;
	connected: boolean;
	threads: Iterable<{
		id: string;
		title: string;
		parentThreadId: string | null;
		settled: boolean;
		snoozed: boolean;
		archived: boolean;
		status: string;
	}>;
	/** Absent: this adapter cannot say; no findings from it. */
	latestRun?: (threadId: string) => Promise<{ run: RunSnap; items: TurnSnap[] } | undefined>;
	readFailed?: (threadId: string, error: unknown) => void;
};

/** Pure: findings for threads whose latest completed run was undelivered. */
export function undeliveredFindings(
	hits: { server: string; threadId: string; title: string; runId: string }[],
): Finding[] {
	return hits.map((h) => ({
		dedupKey: `${h.server}:${h.threadId}:${h.runId}`,
		text: undeliveredText(h.server, h.threadId, h.title, h.runId),
		// Prompt: one wake per undelivered run; a later resend that works resolves the item.
		repeatIntervalMs: 15 * 60_000,
	}));
}

const IDLE_STATUSES = new Set(["idle", "completed"]);

type Hit = { server: string; threadId: string; title: string; runId: string };

const isCandidate = (
	th: UndeliveredSource["threads"] extends Iterable<infer T> ? T : never,
	skip: ReadonlySet<string>,
) =>
	th.parentThreadId === null &&
	!th.settled &&
	!th.snoozed &&
	!th.archived &&
	IDLE_STATUSES.has(th.status) &&
	!skip.has(th.id);

async function hitOf(
	src: UndeliveredSource,
	th: { id: string; title: string },
	maxDurationMs: number,
): Promise<Hit | undefined> {
	const read = src.latestRun;
	if (!read) return undefined;
	try {
		const look = await read(th.id);
		if (!look) return undefined;
		const run = look.run.status === "completed" ? look.run : latestCompletedRun([look.run]);
		if (!run?.id || !isUndeliveredRun(run, look.items, maxDurationMs)) return undefined;
		return { server: src.server, threadId: th.id, title: th.title, runId: run.id };
	} catch (e) {
		src.readFailed?.(th.id, e);
		return undefined;
	}
}

/** Scans every source for undelivered runs. */
export async function selectUndelivered(
	sources: readonly UndeliveredSource[],
	maxDurationMs: number,
	skip: ReadonlySet<string> = new Set(),
): Promise<Hit[]> {
	const out: Hit[] = [];
	for (const src of sources) {
		if (!src.connected || !src.latestRun) continue;
		const candidates = [...src.threads].filter((th) => isCandidate(th, skip));
		for (let i = 0; i < candidates.length; i += 8) {
			const batch = await Promise.all(candidates.slice(i, i + 8).map((th) => hitOf(src, th, maxDurationMs)));
			for (const h of batch) if (h) out.push(h);
		}
	}
	return out;
}

/** The check as an item source. */
export function undeliveredSource(o: {
	cfg: Pick<UndeliveredConfig, "maxDurationSeconds">;
	select: () => Promise<{ server: string; threadId: string; title: string; runId: string }[]>;
}): ItemSource {
	return {
		name: SOURCE,
		run: async () => undeliveredFindings(await o.select()),
	};
}

/** The undelivered settings from `sweep.undelivered`, or the defaults when the sweep section cannot be read. */
export function undeliveredConfig(conf = CONF): UndeliveredConfig {
	try {
		const raw = cfg(conf, "sweep");
		if (raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return parseUndelivered(undefined);
		return parseUndelivered((raw as { undelivered?: unknown }).undelivered);
	} catch {
		return parseUndelivered(undefined);
	}
}

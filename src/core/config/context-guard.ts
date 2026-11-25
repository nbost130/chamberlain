type Limits = { compactAt: number; watchAt: number; share?: number };
type Fallback = { unknownTurns: number; handoffTurns: number };
export type GuardedThread = { threadId: string; action: "compact" | "alarm"; limits: Limits };

const DEFAULT_COMPACT = 130_000;
const DEFAULT_WATCH = 100_000;
const DEFAULT_UNKNOWN = 3;
const DEFAULT_HANDOFF = 60;

function record(value: unknown, path: string, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error(`${path} must be an object`);
	const o = value as Record<string, unknown>;
	const extra = Object.keys(o).find((key) => !keys.includes(key));
	if (extra) throw Error(`${path}: unknown key "${extra}"`);
	return o;
}

function number(value: unknown, path: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
		throw Error(`${path} must be a whole number from 1 to ${max}`);
	return value;
}

function share(value: unknown, path: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1)
		throw Error(`${path} must be a share above 0 and at most 1`);
	return value;
}

export function parseContextGuard(value: unknown, compactAt = DEFAULT_COMPACT): Limits & Fallback {
	const path = "contextGuard";
	const o = record(value ?? {}, path, ["watchTokens", "compactShare", "unknownTurns", "handoffTurns"]);
	const unknownTurns = number(o.unknownTurns, `${path}.unknownTurns`, DEFAULT_UNKNOWN, 10_000);
	const handoffTurns = number(o.handoffTurns, `${path}.handoffTurns`, DEFAULT_HANDOFF, 10_000);
	if (handoffTurns < unknownTurns) throw Error(`${path}.handoffTurns must be at least unknownTurns`);
	return {
		compactAt,
		watchAt: number(o.watchTokens, `${path}.watchTokens`, DEFAULT_WATCH),
		share: share(o.compactShare, `${path}.compactShare`),
		unknownTurns,
		handoffTurns,
	};
}

function guardedThread(v: unknown, index: number, defaults: Limits): GuardedThread {
	const path = `guardedThreads[${index}]`;
	const o = record(v, path, ["threadId", "action", "compactTokens", "compactShare"]);
	const { threadId, action } = o;
	if (typeof threadId !== "string" || !threadId.trim() || threadId.trim() !== threadId)
		throw Error(`${path}.threadId must be a non-empty thread id`);
	if (action !== "compact" && action !== "alarm") throw Error(`${path}.action must be "compact" or "alarm"`);
	return {
		threadId,
		action,
		limits: {
			...defaults,
			compactAt: number(o.compactTokens, `${path}.compactTokens`, defaults.compactAt),
			share: share(o.compactShare, `${path}.compactShare`) ?? defaults.share,
		},
	};
}

export function parseGuardedThreads(v: unknown, defaults = parseContextGuard(undefined)): GuardedThread[] {
	if (v == null) return [];
	if (!Array.isArray(v)) throw Error("guardedThreads must be a list");
	const threads = v.map((row, index) => guardedThread(row, index, defaults));
	if (new Set(threads.map((row) => row.threadId)).size !== threads.length)
		throw Error("guardedThreads must not repeat a thread id");
	return threads;
}

export function effectiveLimits(limits: Limits, window?: number): { compactAt: number; watchAt: number } {
	const compactAt =
		window && limits.share !== undefined ? Math.min(limits.compactAt, window * limits.share) : limits.compactAt;
	return { compactAt, watchAt: Math.min(limits.watchAt, compactAt) };
}

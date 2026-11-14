/**
 * `classifyIdle`: the idle-thread classifier between the selection and the findings (docs/design/thread-state-classifier.md).
 *
 *   selectIdleThreads()  -> plain IdleThread records
 *   classifyIdle()       -> a disposition per thread: cache lookup by (server, threadId, lastMessageHash, bankVersion); only the misses
 *                           are classified, within budget; every attempt is written to thread_dispositions
 *   idleParentFindings() -> in live mode drops ignore and settle and tags the rest; in shadow mode reports exactly as before
 *
 * The cache only answers "have we already classified this exact message with this exact bank?". It is not a second dedupe: the item system
 * alone decides what notifies. A cached row's action is decided again on every run from its stored answers, because an armed-wait claim
 * stops counting once the thread has been idle `armedGraceMinutes`; that needs no new call.
 *
 * A thread that cannot be classified (provider error, malformed answer, redaction hook failure, budget spent) is `unknown` and reported
 * exactly as today: a classifier failure never silences the net. This function never throws.
 *
 * Nothing it writes holds message text: answers, reasons, how many characters left the machine and how many redactions were made.
 */
import { createHash } from "node:crypto";
import { readSecret } from "../layout.ts";
import type { Log } from "../log.ts";
import type { DispositionAction, DispositionKey, Store } from "../store.ts";
import { type Bank, combine, type Decision } from "./bank.ts";
import { type ClassifierConfig, loadBank, SENDS_TEXT } from "./config.ts";
import { haikuProvider, jevProvider, type Provider, ProviderError, rulesProvider } from "./providers.ts";
import { buildState, type HookRunner, runRedactHook, type SentState, sentChars, type ThreadText } from "./state.ts";

/** One idle thread as the classifier needs it: where it is, which message, how long idle, and the text it may read. */
export type ClassifyThread = ThreadText & {
	server: string;
	threadId: string;
	lastMessageHash: string;
	idleMinutes: number;
};
/** What the classifier decided for one thread. `reasons` carry the probabilities, strongest first. */
export type Classified = { action: DispositionAction; reasons: { id: string; p: number }[]; error?: string };
export type ClassifyDeps = {
	store: Store;
	/** The config directory: where a bank file and the key file are read from. */
	conf: string;
	log: Log;
	now: number;
	/** Test seam: the provider for a config. Production builds the real one (`buildProvider`). */
	provider?: (c: ClassifierConfig, conf: string) => Provider;
	/** Test seam: how the redaction hook runs. */
	hook?: HookRunner;
};

/** The state-table key of the day's attempt count: every call to a provider that sends text, and what they cost. */
export const USAGE_KEY = "classifier-usage";
export type DailyUsage = { day: string; calls: number; usd: number };

/** How many classification calls run at once. */
export const CONCURRENCY = 4;
const DAY_MS = 24 * 3600_000;

/** The real provider a config names. `none` has none. */
export function buildProvider(c: ClassifierConfig, conf: string): Provider {
	switch (c.provider) {
		case "rules":
			return rulesProvider();
		case "jev":
			return jevProvider({
				model: c.jev.model,
				timeoutMs: c.jev.timeoutMs,
				// Read at the call, from the config directory's secrets/ (mode 0600). Never logged, never in the web process.
				key: () => readSecret(conf, c.jev.keyFile),
			});
		case "haiku":
			return haikuProvider(c.haiku);
		default:
			throw Error("the classifier is off");
	}
}

/**
 * Pure: the bank version. Everything that changes what a provider is asked or what it answers with: the bank, the thresholds, the
 * provider and its model, and the send and redact settings. Changing any of them reclassifies on the next run; nothing else does.
 */
export function bankVersion(bank: Bank, c: ClassifierConfig, model: string): string {
	const v = JSON.stringify({
		bank,
		thresholds: c.thresholds,
		provider: c.provider,
		model,
		send: c.send,
		redact: c.redact,
	});
	return createHash("sha256").update(v).digest("hex").slice(0, 16);
}

/** Pure: the start of `now`'s UTC day, in ms. The daily budget resets there. */
export const utcDayStart = (now: number) => now - (now % DAY_MS);

const short = (e: unknown) =>
	String(e instanceof Error ? e.message : e)
		.slice(0, 200)
		.toWellFormed();
const unknownOf = (error: string): Classified => ({ action: "unknown", reasons: [], error });
const decided = (d: Decision): Classified => ({ action: d.action, reasons: d.reasons });

/** Everything one `classifyIdle` run shares: what it was given, what it has answered, and the budget it has used. */
type Run = {
	c: ClassifierConfig;
	d: ClassifyDeps;
	out: Map<string, Classified>;
	bank: Bank;
	provider: Provider;
	version: string;
	/** Whether the provider sends message text off the machine, so the budget counts it. */
	sends: boolean;
	day: string;
	used: { calls: number; usd: number };
	started: number;
	spent: number;
	cached: number;
	dailySpent: boolean;
	budgetNote: string | undefined;
};

const keyOf = (t: ClassifyThread) => `${t.server}:${t.threadId}:${t.lastMessageHash}`;
const dispositionKey = (t: ClassifyThread, version: string): DispositionKey => ({
	server: t.server,
	threadId: t.threadId,
	messageHash: t.lastMessageHash,
	bankVersion: version,
});

const decide = (run: Run, t: ClassifyThread, answers: Record<string, number>) =>
	combine(
		run.bank,
		answers,
		{ humanAsked: t.previous.from === "human", idleMinutes: t.idleMinutes },
		{ thresholds: run.c.thresholds, armedGraceMinutes: run.c.armedGraceMinutes },
	);

/** The bank and the provider. When they cannot be made, every thread is answered `unknown` and this returns undefined. */
function start(
	threads: readonly ClassifyThread[],
	c: ClassifierConfig,
	d: ClassifyDeps,
	out: Map<string, Classified>,
): { bank: Bank; provider: Provider } | undefined {
	try {
		return { bank: loadBank(d.conf, c), provider: (d.provider ?? buildProvider)(c, d.conf) };
	} catch (e) {
		d.log("classifier-error", { error: short(e) });
		for (const t of threads) out.set(keyOf(t), unknownOf(`the classifier could not start: ${short(e)}`));
		return undefined;
	}
}

/**
 * Answers `t` from the cache when it holds a classified row for this exact message and bank, deciding its action again from the stored
 * answers. True when `t` is settled (answered, or the cache could not be read and it is `unknown`); false when it needs a call.
 */
function answeredFromCache(run: Run, t: ClassifyThread): boolean {
	const k = dispositionKey(t, run.version);
	try {
		const row = run.d.store.dispositions.get(k);
		if (!row || row.action === "unknown") return false;
		const now = decide(run, t, row.answers);
		const ids = now.reasons.map((r) => r.id);
		if (now.action !== row.action || ids.join(",") !== row.reasons.join(",") || row.mode !== run.c.mode)
			run.d.store.dispositions.redecide(k, {
				action: now.action as Exclude<DispositionAction, "unknown">,
				reasons: ids,
				idleMinutes: t.idleMinutes,
				mode: run.c.mode,
			});
		run.out.set(keyOf(t), decided(now));
		run.cached++;
		return true;
	} catch (e) {
		run.out.set(keyOf(t), unknownOf(`the disposition cache could not be read: ${short(e)}`));
		return true;
	}
}

/**
 * The day's usage so far, for a provider that sends text. Every attempt is counted in the state table as it is made (a retry of a failed
 * call counts again, though it replaces its one disposition row), and the count is never taken as less than the dispositions' own sum for the day.
 */
function readDailyUsage(run: Run): { calls: number; usd: number } {
	try {
		if (!run.sends) return { calls: 0, usd: 0 };
		const rows = run.d.store.dispositions.usage(utcDayStart(run.d.now), SENDS_TEXT);
		const counted = run.d.store.state.get<DailyUsage>(USAGE_KEY);
		const today = counted?.day === run.day ? counted : { calls: 0, usd: 0 };
		return { calls: Math.max(rows.calls, today.calls), usd: Math.max(rows.usd, today.usd) };
	} catch (e) {
		run.d.log("classifier-error", { error: `the day's usage could not be read: ${short(e)}` });
		return { calls: Number.POSITIVE_INFINITY, usd: 0 };
	}
}

/** Adds calls and spend to the day's count in the state table. Only a provider that sends text is counted; a failure is logged, not thrown. */
function countUsage(run: Run, calls: number, usd: number) {
	if (!run.sends || (!calls && !usd)) return;
	try {
		run.d.store.state.update<DailyUsage>(USAGE_KEY, (prior) => {
			const p = prior?.day === run.day ? prior : { day: run.day, calls: 0, usd: 0 };
			return { day: run.day, calls: p.calls + calls, usd: p.usd + usd };
		});
	} catch (e) {
		run.d.log("classifier-error", { error: `the day's usage could not be counted: ${short(e)}` });
	}
}

/** Why no more calls may start, or undefined while the budget holds. */
function budgetLeft(run: Run): string | undefined {
	const { budget } = run.c;
	if (run.started >= budget.maxPerRun) return "budget: maxPerRun reached this run; classified on a later run";
	if (run.sends && run.used.calls + run.started >= budget.maxCallsPerDay)
		return "budget: maxCallsPerDay spent until the next UTC day";
	if (run.sends && run.used.usd + run.spent >= budget.maxUsdPerDay)
		return "budget: maxUsdPerDay spent until the next UTC day";
	return undefined;
}

/** What went out of the machine for one attempt, filled in as it goes so a failure can still report it. */
type Attempt = { sent: number; redactions: number };

/** One provider call for `t`: the state it may see (redacted when text leaves the machine), the call, and its cost counted. */
async function ask(run: Run, t: ClassifyThread, attempt: Attempt) {
	const { c, d } = run;
	let state: SentState;
	if (run.sends) {
		const built = buildState(t, c.send, c.redact.builtin);
		state = built.state;
		attempt.redactions = built.redactions;
		// The hook fails closed: when it throws, nothing has been sent.
		if (c.redact.command) state = await runRedactHook(c.redact.command, state, d.hook);
		attempt.sent = sentChars(state);
	} else state = buildState(t, c.send, false).state;
	countUsage(run, 1, 0);
	const r = await run.provider.classify(state, run.bank);
	if (r.costUsd) {
		run.spent += r.costUsd;
		countUsage(run, 0, r.costUsd);
	}
	return r;
}

const baseOf = (run: Run, t: ClassifyThread) => ({
	...dispositionKey(t, run.version),
	classifiedAt: run.d.now,
	provider: run.provider.name,
	mode: run.c.mode,
	idleMinutes: t.idleMinutes,
});

/** A call that failed: `t` is `unknown`, a cost it still incurred is counted, and the failed attempt is written as its disposition. */
function recordFailure(run: Run, t: ClassifyThread, attempt: Attempt, e: unknown) {
	const error = short(e);
	run.out.set(keyOf(t), unknownOf(error));
	// A call that failed after it was billed still reports its cost.
	const usage = e instanceof ProviderError ? e.usage : {};
	if (usage.costUsd) {
		run.spent += usage.costUsd;
		countUsage(run, 0, usage.costUsd);
	}
	try {
		run.d.store.dispositions.put({
			...baseOf(run, t),
			model: null,
			action: "unknown",
			reasons: [],
			answers: {},
			sentChars: attempt.sent,
			redactions: attempt.redactions,
			inputTokens: usage.inputTokens ?? null,
			costUsd: usage.costUsd ?? null,
			latencyMs: null,
			error,
		});
	} catch (w) {
		run.d.log("classifier-error", { error: `a disposition could not be written: ${short(w)}` });
	}
}

/** Classifies one thread with the provider and writes the disposition; a failure becomes `unknown`. */
async function classifyOne(run: Run, t: ClassifyThread) {
	const attempt: Attempt = { sent: 0, redactions: 0 };
	try {
		const r = await ask(run, t, attempt);
		const decision = decide(run, t, r.answers);
		run.d.store.dispositions.put({
			...baseOf(run, t),
			model: r.model,
			action: decision.action,
			reasons: decision.reasons.map((x) => x.id),
			answers: r.answers,
			sentChars: attempt.sent,
			redactions: attempt.redactions,
			inputTokens: r.inputTokens ?? null,
			costUsd: r.costUsd ?? null,
			latencyMs: r.latencyMs,
			error: null,
		});
		run.out.set(keyOf(t), decided(decision));
	} catch (e) {
		recordFailure(run, t, attempt, e);
	}
}

/** The next miss: answered `unknown` when the budget is spent, else counted as started and classified. */
async function classifyWithinBudget(run: Run, t: ClassifyThread) {
	const over = budgetLeft(run);
	if (over) {
		run.budgetNote ??= over;
		if (over.includes("UTC day")) run.dailySpent = true;
		run.out.set(keyOf(t), unknownOf(over));
		return;
	}
	run.started++;
	await classifyOne(run, t);
}

/** In the selection's order, whatever order the calls finished in. Every thread has an answer by now. */
function inSelectionOrder(threads: readonly ClassifyThread[], out: Map<string, Classified>): Map<string, Classified> {
	return new Map(
		threads.map((t) => {
			const answer = out.get(keyOf(t));
			if (!answer) throw Error(`classifyIdle: no answer was recorded for ${keyOf(t)}`);
			return [keyOf(t), answer] as const;
		}),
	);
}

function logRun(run: Run, ordered: Map<string, Classified>) {
	const counts: Record<string, number> = {};
	for (const v of ordered.values()) counts[v.action] = (counts[v.action] ?? 0) + 1;
	run.d.log("classifier", {
		provider: run.provider.name,
		mode: run.c.mode,
		calls: run.started,
		cached: run.cached,
		...counts,
		...(run.budgetNote ? { budget: run.budgetNote } : {}),
		...(run.dailySpent ? { dailyBudgetSpent: true } : {}),
	});
}

/**
 * The dispositions of `threads`, keyed by `${server}:${threadId}:${lastMessageHash}` (the idle-parents item key). An empty map when the
 * classifier is off. Threads are taken in the order given, so the budget goes to the selection's first threads.
 */
export async function classifyIdle(
	threads: readonly ClassifyThread[],
	c: ClassifierConfig,
	d: ClassifyDeps,
): Promise<Map<string, Classified>> {
	const out = new Map<string, Classified>();
	if (c.provider === "none" || !threads.length) return out;
	const started = start(threads, c, d, out);
	if (!started) return out;
	const run: Run = {
		c,
		d,
		out,
		...started,
		version: bankVersion(started.bank, c, started.provider.model),
		sends: SENDS_TEXT.includes(c.provider),
		day: new Date(utcDayStart(d.now)).toISOString().slice(0, 10),
		used: { calls: 0, usd: 0 },
		started: 0,
		spent: 0,
		cached: 0,
		dailySpent: false,
		budgetNote: undefined,
	};
	const misses = threads.filter((t) => !answeredFromCache(run, t));
	// The budget: this run's calls, and (for a provider that sends text) the UTC day's calls and spend.
	run.used = readDailyUsage(run);
	// The workers share one iterator, so each miss is taken once, in order.
	const queue = misses.values();
	const worker = async () => {
		for (const t of queue) await classifyWithinBudget(run, t);
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, worker));
	const ordered = inSelectionOrder(threads, out);
	logRun(run, ordered);
	return ordered;
}

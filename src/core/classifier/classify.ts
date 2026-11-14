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
import type { Store } from "../store.ts";
import type { DispositionAction } from "../store-records.ts";
import type { Bank } from "./bank.ts";
import { budgetLeft, readDailyUsage, utcDayStart } from "./classify-budget.ts";
import { classifyOne } from "./classify-one.ts";
import { decide, decided, dispositionKey, keyOf, short, unknownOf } from "./classify-shared.ts";
import { type ClassifierConfig, loadBank, SENDS_TEXT } from "./config.ts";
import { haikuProvider, jevProvider, type Provider, rulesProvider } from "./providers.ts";
import type { HookRunner, ThreadText } from "./state.ts";

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

/** How many classification calls run at once. */
const CONCURRENCY = 4;

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

/** Everything one `classifyIdle` run shares: what it was given, what it has answered, and the budget it has used. */
export type Run = {
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

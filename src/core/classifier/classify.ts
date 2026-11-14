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

const short = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);
const unknownOf = (error: string): Classified => ({ action: "unknown", reasons: [], error });
const decided = (d: Decision): Classified => ({ action: d.action, reasons: d.reasons });

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
	const keyOf = (t: ClassifyThread) => `${t.server}:${t.threadId}:${t.lastMessageHash}`;
	let bank: Bank, provider: Provider;
	try {
		bank = loadBank(d.conf, c);
		provider = (d.provider ?? buildProvider)(c, d.conf);
	} catch (e) {
		d.log("classifier-error", { error: short(e) });
		for (const t of threads) out.set(keyOf(t), unknownOf(`the classifier could not start: ${short(e)}`));
		return out;
	}
	const version = bankVersion(bank, c, provider.model);
	const factsOf = (t: ClassifyThread) => ({ humanAsked: t.previous.from === "human", idleMinutes: t.idleMinutes });
	const decide = (t: ClassifyThread, answers: Record<string, number>) =>
		combine(bank, answers, factsOf(t), { thresholds: c.thresholds, armedGraceMinutes: c.armedGraceMinutes });
	const sends = SENDS_TEXT.includes(c.provider);

	let cached = 0;
	const misses: ClassifyThread[] = [];
	for (const t of threads) {
		const k: DispositionKey = {
			server: t.server,
			threadId: t.threadId,
			messageHash: t.lastMessageHash,
			bankVersion: version,
		};
		try {
			const row = d.store.dispositions.get(k);
			if (row && row.action !== "unknown") {
				const now = decide(t, row.answers);
				const ids = now.reasons.map((r) => r.id);
				if (now.action !== row.action || ids.join(",") !== row.reasons.join(",") || row.mode !== c.mode)
					d.store.dispositions.redecide(k, {
						action: now.action as Exclude<DispositionAction, "unknown">,
						reasons: ids,
						idleMinutes: t.idleMinutes,
						mode: c.mode,
					});
				out.set(keyOf(t), decided(now));
				cached++;
				continue;
			}
		} catch (e) {
			out.set(keyOf(t), unknownOf(`the disposition cache could not be read: ${short(e)}`));
			continue;
		}
		misses.push(t);
	}

	// The budget: this run's calls, and (for a provider that sends text) the UTC day's calls and spend. Every attempt is counted in the
	// state table as it is made (a retry of a failed call counts again, though it replaces its one disposition row), and the count is never
	// taken as less than the dispositions' own sum for the day.
	const day = new Date(utcDayStart(d.now)).toISOString().slice(0, 10);
	let used = { calls: 0, usd: 0 };
	try {
		if (sends) {
			const rows = d.store.dispositions.usage(utcDayStart(d.now), SENDS_TEXT);
			const counted = d.store.state.get<DailyUsage>(USAGE_KEY);
			const today = counted?.day === day ? counted : { calls: 0, usd: 0 };
			used = { calls: Math.max(rows.calls, today.calls), usd: Math.max(rows.usd, today.usd) };
		}
	} catch (e) {
		used = { calls: Number.POSITIVE_INFINITY, usd: 0 };
		d.log("classifier-error", { error: `the day's usage could not be read: ${short(e)}` });
	}
	const count = (calls: number, usd: number) => {
		if (!sends || (!calls && !usd)) return;
		try {
			d.store.state.update<DailyUsage>(USAGE_KEY, (prior) => {
				const p = prior?.day === day ? prior : { day, calls: 0, usd: 0 };
				return { day, calls: p.calls + calls, usd: p.usd + usd };
			});
		} catch (e) {
			d.log("classifier-error", { error: `the day's usage could not be counted: ${short(e)}` });
		}
	};
	let started = 0;
	let spent = 0;
	let dailySpent = false;
	const budgetLeft = (): string | undefined => {
		if (started >= c.budget.maxPerRun) return "budget: maxPerRun reached this run; classified on a later run";
		if (sends && used.calls + started >= c.budget.maxCallsPerDay)
			return "budget: maxCallsPerDay spent until the next UTC day";
		if (sends && used.usd + spent >= c.budget.maxUsdPerDay) return "budget: maxUsdPerDay spent until the next UTC day";
		return undefined;
	};

	const one = async (t: ClassifyThread) => {
		const k: DispositionKey = {
			server: t.server,
			threadId: t.threadId,
			messageHash: t.lastMessageHash,
			bankVersion: version,
		};
		let sent = 0;
		let redactions = 0;
		const base = { ...k, classifiedAt: d.now, provider: provider.name, mode: c.mode, idleMinutes: t.idleMinutes };
		try {
			let state: SentState;
			if (sends) {
				const built = buildState(t, c.send, c.redact.builtin);
				state = built.state;
				redactions = built.redactions;
				// The hook fails closed: when it throws, nothing has been sent.
				if (c.redact.command) state = await runRedactHook(c.redact.command, state, d.hook);
				sent = sentChars(state);
			} else state = buildState(t, c.send, false).state;
			count(1, 0);
			const r = await provider.classify(state, bank);
			if (r.costUsd) {
				spent += r.costUsd;
				count(0, r.costUsd);
			}
			const decision = decide(t, r.answers);
			d.store.dispositions.put({
				...base,
				model: r.model,
				action: decision.action,
				reasons: decision.reasons.map((x) => x.id),
				answers: r.answers,
				sentChars: sent,
				redactions,
				inputTokens: r.inputTokens ?? null,
				costUsd: r.costUsd ?? null,
				latencyMs: r.latencyMs,
				error: null,
			});
			out.set(keyOf(t), decided(decision));
		} catch (e) {
			const error = short(e);
			out.set(keyOf(t), unknownOf(error));
			// A call that failed after it was billed still reports its cost.
			const usage = e instanceof ProviderError ? e.usage : {};
			if (usage.costUsd) {
				spent += usage.costUsd;
				count(0, usage.costUsd);
			}
			try {
				d.store.dispositions.put({
					...base,
					model: null,
					action: "unknown",
					reasons: [],
					answers: {},
					sentChars: sent,
					redactions,
					inputTokens: usage.inputTokens ?? null,
					costUsd: usage.costUsd ?? null,
					latencyMs: null,
					error,
				});
			} catch (w) {
				d.log("classifier-error", { error: `a disposition could not be written: ${short(w)}` });
			}
		}
	};

	let budgetNote: string | undefined;
	let next = 0;
	const worker = async () => {
		while (next < misses.length) {
			const t = misses[next++]!;
			const over = budgetLeft();
			if (over) {
				budgetNote ??= over;
				if (over.includes("UTC day")) dailySpent = true;
				out.set(keyOf(t), unknownOf(over));
				continue;
			}
			started++;
			await one(t);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, worker));

	// In the selection's order, whatever order the calls finished in.
	const ordered = new Map(threads.map((t) => [keyOf(t), out.get(keyOf(t))!] as const));
	const counts: Record<string, number> = {};
	for (const v of ordered.values()) counts[v.action] = (counts[v.action] ?? 0) + 1;
	d.log("classifier", {
		provider: provider.name,
		mode: c.mode,
		calls: started,
		cached,
		...counts,
		...(budgetNote ? { budget: budgetNote } : {}),
		...(dailySpent ? { dailyBudgetSpent: true } : {}),
	});
	return ordered;
}

/** Classifying one thread: asking the provider, and recording a failure as an unknown. */

import { type ClassifyThread, decide, decided, dispositionKey, keyOf, type Run, short, unknownOf } from "./classify.ts";
import { countUsage } from "./classify-budget.ts";
import { ProviderError } from "./providers.ts";
import { buildState, runRedactHook, type SentState, sentChars } from "./state.ts";

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
export async function classifyOne(run: Run, t: ClassifyThread) {
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

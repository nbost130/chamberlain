import type { Adapter } from "../adapter/adapter.ts";
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
import { effectiveLimits, type GuardedThread, type parseContextGuard } from "../config/context-guard.ts";
import type { Log } from "../log.ts";
import type { Store } from "../store/store.ts";
import { type CompactState, createCompactionCheck } from "./engine-steward.ts";

type Policy = ReturnType<typeof parseContextGuard>;
type Episode = { session: string; turn: number; count: number; first: number; announced?: boolean };
type Notice = (key: string, title: string, summary: string) => void;
type GuardDeps = { store: Store; policy: Policy; alarm: Notice };

function episode(prior: Episode | undefined, probe: StewardProbe): Episode | undefined {
	const { context, contextSession: session, completedTurn: turn, previousCompletedTurn, unknownTurns } = probe;
	if (!context || !session || turn === undefined || !unknownTurns?.includes(turn)) return undefined;
	if (!("unknown" in context) || probe.contextTurn !== turn) return undefined;
	if (prior?.session === session && prior.turn === turn) return prior;
	const oldest = unknownTurns.at(-1) ?? turn;
	const follows =
		prior?.session === session &&
		(unknownTurns.includes(prior.turn) || (probe.partialContextHistory && prior.turn === previousCompletedTurn));
	return {
		session,
		turn,
		count: follows ? prior.count + unknownTurns.filter((n) => n > prior.turn).length : unknownTurns.length,
		first: follows ? prior.first : oldest,
		announced: follows ? prior.announced : undefined,
	};
}

function watchUnknown({ store, policy, alarm }: GuardDeps, id: string, probe: StewardProbe): string | undefined {
	const key = `context-unknown:${id}`;
	const prior = store.state.get<Episode>(key);
	let next = episode(prior, probe);
	if (!next) {
		if (prior && probe.context && "tokens" in probe.context) store.state.delete(key);
		return undefined;
	}
	if (next.count >= policy.unknownTurns && !next.announced) {
		const alarmKey = `${key}:${next.session}:${next.first}`;
		alarm(
			alarmKey,
			"Thread context is unknown",
			`Thread ${id}: ${next.count} completed turns without a context reading.`,
		);
		next = { ...next, announced: true };
	}
	if (next !== prior) store.state.set(key, next);
	return next.count >= policy.handoffTurns
		? `Context is unknown after at least ${policy.handoffTurns} consecutive completed turns. The turn-count fallback calls for a hand-off.`
		: undefined;
}

type HandoffReason = { thread: string; session: string; reason: string };

export function stewardFallback(d: GuardDeps, lastCompaction: () => CompactState | undefined) {
	let current: HandoffReason | undefined;
	return {
		get: () => current,
		check: (id: string, p: StewardProbe, compactAt: number) => {
			const unknown = watchUnknown(d, id, p);
			const last = lastCompaction();
			const failedRequest = last?.thread === id && last.session === p.contextSession && !last.cleared;
			const unsupported = p.canCompact === false && ((p.contextTokens ?? 0) > compactAt || failedRequest);
			const reason = unsupported ? "This provider cannot compact the thread. The Steward needs a hand-off." : unknown;
			current = reason && p.contextSession ? { thread: id, session: p.contextSession, reason } : undefined;
			return unsupported;
		},
	};
}

function overLimitNotice(d: ThreadGuardDeps, key: string, id: string, summary: string) {
	if (d.store.state.get<boolean>(key)) return;
	d.alarm(key, "Guarded thread needs attention", `Thread ${id}: ${summary}`);
	d.store.state.set(key, true);
}

type ThreadGuardDeps = GuardDeps & { adapter: Adapter; log: Log; dry: boolean; canOperate: () => boolean };

function guardedCheck(d: ThreadGuardDeps, thread: GuardedThread) {
	const { threadId: id, action, limits } = thread;
	const stateKey = `context-compact:${id}`;
	const compactState = {
		get: () => d.store.state.get<CompactState>(stateKey),
		set: (s: CompactState) => d.store.state.set(stateKey, s),
	};
	const warningKey = `context-limit:${id}`;
	const notice = (text: string) => overLimitNotice(d, warningKey, id, text);
	const compact = createCompactionCheck({
		compactReady: () => Boolean(d.adapter.compactThread),
		compact: async (deliveryId) => {
			if (!d.canOperate()) return { ok: false };
			const result = await d.adapter.compactThread?.(id, deliveryId);
			if (!result?.ok) notice("the compaction request was not confirmed.");
			return result ?? { ok: false };
		},
		log: d.log,
		dry: d.dry,
		raiseAlarm: () => notice("no compaction transport is configured."),
		compactAt: limits.compactAt,
		compactState,
	});
	const tryCompact = async (p: StewardProbe, compactAt: number) => {
		await compact(p, id, compactAt);
		const latest = compactState.get();
		if (latest?.failed && latest.session === p.contextSession)
			notice("compaction did not bring context below its limit.");
	};
	const checkPending = async (p: StewardProbe) => {
		const pending = compactState.get();
		if (!pending || pending.session !== p.contextSession) return;
		if (p.canCompact === false) notice("this provider refused compaction.");
		else await tryCompact({ ...p, contextTokens: undefined }, limits.compactAt);
	};
	return async (p: StewardProbe) => {
		watchUnknown(d, id, p);
		if (!p.context || "unknown" in p.context) return checkPending(p);
		const { compactAt } = effectiveLimits(limits, p.context.window);
		if (p.context.tokens <= compactAt) {
			if (d.store.state.get<boolean>(warningKey)) d.store.state.delete(warningKey);
			await compact(p, id, compactAt);
			return;
		}
		if (action === "alarm" || p.canCompact === false) {
			notice(`context is ${p.context.tokens} tokens, past its ${compactAt}-token limit.`);
			return;
		}
		await tryCompact(p, compactAt);
	};
}

export function guardedThreads(d: ThreadGuardDeps, threads: GuardedThread[]) {
	const checks = threads.map((thread) => ({ id: thread.threadId, check: guardedCheck(d, thread) }));
	return async (steward: string | undefined) => {
		for (const { id, check } of checks) {
			if (id === steward) continue;
			const p = d.adapter.stewardProbe?.(id, d.policy.unknownTurns);
			if (p) await check(p);
		}
	};
}

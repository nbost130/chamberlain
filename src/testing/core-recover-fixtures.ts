import type { ThreadState } from "../core/adapter/adapter.ts";
import { normalizeThread } from "../core/adapter/adapter.ts";
import type { RunFailure, RunLook } from "../core/adapter/adapter-inspect.ts";
import type { JudgeAnswer } from "../core/ops/judge.ts";
import { createRecovery } from "../core/ops/recover.ts";
import type { FailureKind } from "../core/ops/recover-classify.ts";
import type { Handling, RecoverDeps, RecoverStore } from "../core/ops/recover-state.ts";

export const NOW = Date.parse("2026-11-13T12:00:00Z");

export const t = (over: Partial<ThreadState> = {}): ThreadState =>
	normalizeThread({ id: "t1", title: "Thread one", status: "failed", latestRunId: "run-1", ...over });

export const ctx = { stewardId: "steward", decisionsId: "decisions", children: 0 };

/** A recovery on a manual clock: timers run when the test advances time, and every effect is recorded. */
type World = {
	now: () => number;
	states: Map<string, ThreadState>;
	failures: Map<string, RunFailure | undefined>;
	instruction: Map<string, string>;
};

export function rig(
	o: {
		failures?: Record<string, RunFailure | undefined>;
		judge?: () => JudgeAnswer;
		ping?: () => {
			ok: boolean;
			detail: string;
		} /** runs when a ping is sent, before it is answered: a crash is simulated here */;
		onPing?: () => void;
		ctxOver?: Partial<RecoverDeps>;
		store?: RecoverStore;
		look?: (
			id: string,
		) => Promise<RunLook | undefined> /** a rig for the same world after a restart: same clock, threads and store */;
		share?: World;
	} = {},
) {
	let now = o.share?.now() ?? NOW;
	const timers: { at: number; fn: () => void; live: boolean }[] = [];
	const states = o.share?.states ?? new Map<string, ThreadState>();
	const failures = o.share?.failures ?? new Map<string, RunFailure | undefined>(Object.entries(o.failures ?? {}));
	const instruction = o.share?.instruction ?? new Map<string, string>();
	const pings: { threadId: string; text: string; seed: string }[] = [];
	const wakes: { threadId: string; kind: FailureKind; note: string }[] = [];
	const logs: { event: string; data?: Record<string, unknown> }[] = [];
	const judged: { trigger: string; user: string }[] = [];
	const r = createRecovery({
		now: () => now,
		setTimer: (ms, fn) => {
			const x = { at: now + ms, fn, live: true };
			timers.push(x);
			return () => {
				x.live = false;
			};
		},
		stewardId: () => "steward",
		decisionsId: () => "decisions",
		state: (id) => states.get(id),
		/** By default a fresh read agrees with what the daemon holds. */
		look:
			o.look ??
			(async (id) => {
				const th = states.get(id);
				return th
					? {
							latestRunId: th.latestRunId ?? undefined,
							latestStatus: th.status,
							active: ["running", "starting", "queued", "preparing"].includes(th.status),
							waiting: th.status === "waiting" || th.pendingRequestId !== null,
						}
					: undefined;
			}),
		...(o.store ? { store: o.store } : {}),
		children: async () => 0,
		readFailure: async (id) => failures.get(id),
		instructionId: async (id) => instruction.get(id) ?? "m1",
		ping: async (threadId, text, seed) => {
			pings.push({ threadId, text, seed });
			o.onPing?.();
			return o.ping?.() ?? { ok: true, detail: "sent" };
		},
		judge: async (trigger, brief) => {
			judged.push({ trigger, user: brief.user });
			return o.judge?.() ?? { ok: true, backend: "small-model", verdict: "do_not_retry", reason: "it keeps happening" };
		},
		wake: (threadId, kind, note) => wakes.push({ threadId, kind, note }),
		log: (event, data) => logs.push({ event, data }),
		...o.ctxOver,
	});
	/** Moves the clock and runs every timer that falls due, in order, letting each one's async work finish. */
	const advance = async (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			next.live = false;
			now = Math.max(now, next.at);
			next.fn();
			await Bun.sleep(1);
		}
		now = end;
	};
	const fail = (
		id: string,
		f: Partial<RunFailure> & { runId: string },
		over: Partial<ThreadState> = {},
	): Promise<Handling> => {
		const full: RunFailure = { message: "The provider event stream closed unexpectedly.", class: "unknown", ...f };
		failures.set(id, full);
		const th = t({ id, latestRunId: f.runId, ...over });
		states.set(id, th);
		return r.onFailure(th);
	};
	return { r, advance, fail, states, failures, instruction, pings, wakes, logs, judged, now: () => now };
}

export const STREAM = { message: "The provider event stream closed unexpectedly. Retry the turn." };

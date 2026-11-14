import { reportKey, type ThreadState, type TurnItem } from "../core/decide";
import type { InstructionRead } from "../core/history";
import { type ReportWatch, settleReport } from "../core/report";

export const QUIET = 180_000;

export const idle: ThreadState = {
	id: "t1",
	title: "T",
	status: "completed",
	parentThreadId: null,
	pendingRequestId: null,
	settled: false,
	archived: false,
	snoozed: false,
	blockedOnThreadWait: false,
	openPrs: [],
	worktreePath: null,
	linkedPrDone: false,
	backgroundTasks: 0,
	backgroundWork: 0,
};

export const instruction: TurnItem = {
	type: "user_message",
	id: "s1",
	text: "Steward: do it",
	createdBy: "agent",
	creationSource: "mcp",
};

export const completeRead: InstructionRead = { items: [instruction], state: "complete", byMachine: false };

/** The parts of a watch a test leaves alone. The clock only moves when the code under test sleeps. */
export function watch(over: Partial<ReportWatch> = {}) {
	let now = 0;
	let until = QUIET;
	const w: ReportWatch = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		quietUntil: () => until,
		state: () => idle,
		children: async () => 0,
		oldCards: () => new Set(),
		read: async () => completeRead,
		reportKey: () => "report:s1:0",
		idleWork: async () => undefined,
		...over,
	};
	return {
		w,
		clock: () => now,
		pushBack: (to: number) => {
			until = to;
		},
	};
}

type Run = {
	ordinal: number;
	status: string;
	runId: string;
	start: string;
	end: string;
	first: string;
	ask: boolean;
	stall: boolean;
};

export type Timeline = {
	name: string;
	runs: Run[];
	items: (TurnItem & { runId: string })[];
	pending: [string, number][];
};

export const timelines = (await Bun.file(new URL("../core/report.replay.json", import.meta.url)).json()) as Timeline[];

/**
 * A real thread's day through the real decisions, on a fake clock. Same order as Watcher.fire: a turn end is seen 3s
 * after the run stops, asks and stalls wake at once, and a report wake goes through settleReport. T3 reports no
 * background work during a run, so neither does this. Left out: cards, idle wakes, child threads, and how long reads take.
 */
export async function replay(t: Timeline) {
	const ms = (s: string) => Date.parse(s);
	type Ev = { at: number; kind: "start" | "stop" | "ended" | "pending"; run?: Run; n?: number };
	const queue: Ev[] = [
		...t.runs.flatMap((run): Ev[] => [
			{ at: ms(run.start), kind: "start", run },
			{ at: ms(run.end), kind: "stop", run },
			{ at: ms(run.end) + 3000, kind: "ended", run },
		]),
		...t.pending.map(([at, n]): Ev => ({ at: ms(at), kind: "pending", n })),
	].sort((a, b) => a.at - b.at);
	const fired = new Set<string>();
	const wakes: { at: string; key: string }[] = [];
	let now = 0;
	let latest: Run | undefined;
	let lastEnded: Run | undefined;
	let running = false;
	let pending = 0;
	let until: number | undefined;
	let start = false;
	const read = (): InstructionRead => ({
		items: t.items.filter((i) => latest && Number(i.runId.slice(1)) <= latest.ordinal),
		state: "complete",
		byMachine: lastEnded?.first === "notification",
	});
	const wake = (key: string) => {
		fired.add(key);
		wakes.push({ at: new Date(now).toISOString().slice(11, 19), key });
	};
	const apply = (e: Ev) => {
		now = e.at;
		if (e.kind === "start") {
			latest = e.run;
			running = true;
		}
		if (e.kind === "stop") {
			running = false;
			lastEnded = e.run;
		}
		if (e.kind === "pending") pending = e.n as number;
		if (e.kind !== "ended") return;
		const run = e.run as Run;
		if (run.ask || run.stall) {
			wake(`${run.ask ? "ask" : "stall"}:${run.runId}`);
			return;
		}
		const r = read();
		if (!reportKey(r.items, r.byMachine, fired)) return;
		if (until === undefined) start = true;
		until = now + QUIET;
	};
	const advance = async (to: number) => {
		while (queue.length && queue[0].at <= to) apply(queue.shift() as Ev);
		now = Math.max(now, to);
	};
	const w: ReportWatch = {
		now: () => now,
		sleep: (ms) => advance(now + ms),
		quietUntil: () => until ?? 0,
		state: () => ({ ...idle, status: running ? "running" : "completed", backgroundWork: running ? 0 : pending }),
		children: async () => 0,
		oldCards: () => new Set(),
		read: async () => read(),
		reportKey: (r) => reportKey(r.items, r.byMachine, fired),
		idleWork: async () => undefined,
	};
	while (queue.length || start) {
		if (!start) await advance(queue[0].at);
		if (!start) continue;
		start = false;
		const out = await settleReport(w);
		until = undefined;
		if (out.wake) wake(out.key);
	}
	return wakes;
}

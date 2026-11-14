import { describe, expect, test } from "bun:test";
import { reportKey, type ThreadState, type TurnItem } from "./decide";
import { failedRead, type InstructionRead } from "./history";
import { REPORT_HOLD_MS, reportWait, settleReport, type ReportWatch } from "./report";

const QUIET = 180_000;
const idle: ThreadState = {
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
const instruction: TurnItem = {
	type: "user_message",
	id: "s1",
	text: "Steward: do it",
	createdBy: "agent",
	creationSource: "mcp",
};
const completeRead: InstructionRead = { items: [instruction], state: "complete", byMachine: false };

/** The parts of a watch a test leaves alone. The clock only moves when the code under test sleeps. */
function watch(over: Partial<ReportWatch> = {}) {
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

describe("reportWait", () => {
	test("waits out the quiet window, busy or not", () => {
		expect(reportWait(100, 40, false)).toBe(60);
		expect(reportWait(100, 40, true)).toBe(60);
	});
	test("goes at the end of the window when nothing is running", () => {
		expect(reportWait(100, 100, false)).toBe(0);
	});
	test("keeps waiting past the window while work runs", () => {
		expect(reportWait(100, 100, true, 1000)).toBeGreaterThan(0);
	});
	test("stops waiting at the hold, so a hung task can't swallow a report", () => {
		expect(reportWait(100, 1100, true, 1000)).toBe(0);
	});
});

describe("settleReport", () => {
	test("wakes at the end of the quiet window on a quiet thread", async () => {
		const { w, clock } = watch();
		expect(await settleReport(w)).toEqual({ wake: true, key: "report:s1:0", work: "", running: 0, oldCard: false });
		expect(clock()).toBe(QUIET);
	});
	test("a finished turn pushes the window back", async () => {
		const t = watch();
		let pushed = false;
		t.w.sleep = async (ms) => {
			await watch().w.sleep(ms);
			if (!pushed) {
				pushed = true;
				t.pushBack(QUIET * 2);
			}
		};
		let slept = 0;
		const sleep = t.w.sleep;
		t.w.sleep = async (ms) => {
			slept += ms;
			await sleep(ms);
		};
		t.w.now = () => slept;
		await settleReport(t.w);
		expect(slept).toBe(QUIET * 2);
	});
	test("holds while background work runs, and wakes when it ends", async () => {
		const t = watch();
		t.w.state = () => ({ ...idle, backgroundWork: t.clock() < QUIET * 3 ? 1 : 0 });
		const out = await settleReport(t.w);
		expect(out.wake).toBe(true);
		expect(t.clock()).toBeGreaterThanOrEqual(QUIET * 3);
		expect(t.clock()).toBeLessThan(QUIET * 3 + 31_000);
	});
	test("holds while a child thread runs", async () => {
		const t = watch();
		t.w.children = async () => (t.clock() < QUIET * 2 ? 1 : 0);
		await settleReport(t.w);
		expect(t.clock()).toBeGreaterThanOrEqual(QUIET * 2);
	});
	test("past the hold it wakes anyway and says what is still running", async () => {
		const t = watch();
		t.w.state = () => ({ ...idle, backgroundWork: 2 });
		const out = await settleReport(t.w);
		expect(out).toMatchObject({ wake: true, running: 2 });
		expect(t.clock()).toBe(QUIET + REPORT_HOLD_MS);
	});
	test("a read that outlasts a new turn does not wake on the old state", async () => {
		// The state has to be taken after this read. It was once taken first, and this woke.
		let state = idle;
		const { w } = watch({
			state: () => state,
			read: async () => {
				state = { ...idle, status: "running" };
				return completeRead;
			},
		});
		expect(await settleReport(w)).toEqual({ wake: false, event: "skip-report-superseded" });
	});
	test("a card raised during the idle check does not wake on the old state", async () => {
		let state = idle;
		const { w } = watch({
			state: () => state,
			reportKey: () => undefined,
			idleWork: async () => {
				state = { ...idle, pendingRequestId: "new" };
				return { key: "idle:s1", work: "open PR #1" };
			},
		});
		expect(await settleReport(w)).toEqual({ wake: false, event: "skip-report-superseded" });
	});
	test("a turn that ends during the read restarts the wait, and the read is taken again", async () => {
		let reads = 0;
		const t = watch();
		t.w.read = async () => {
			if (++reads === 1) t.pushBack(QUIET * 2);
			return completeRead;
		};
		expect((await settleReport(t.w)).wake).toBe(true);
		expect(reads).toBe(2);
		expect(t.clock()).toBe(QUIET * 2);
	});
	test("work that starts during the read holds the wake", async () => {
		let reads = 0;
		const t = watch();
		t.w.state = () => ({ ...idle, backgroundWork: reads === 1 && t.clock() < QUIET * 2 ? 1 : 0 });
		t.w.read = async () => {
			reads++;
			return completeRead;
		};
		expect((await settleReport(t.w)).wake).toBe(true);
		expect(t.clock()).toBeGreaterThanOrEqual(QUIET * 2);
	});
	test("one failed read is tried again, so a blip doesn't lose the report", async () => {
		let reads = 0;
		const { w } = watch({
			read: async () => (++reads === 1 ? { items: [], state: "failed", byMachine: false } : completeRead),
		});
		expect((await settleReport(w)).wake).toBe(true);
		expect(reads).toBe(2);
	});
	test("with no connection nothing wakes, even after the retry, and the skip says the read failed", async () => {
		const { w } = watch({ read: async () => failedRead("not connected"), reportKey: () => undefined });
		expect(await settleReport(w)).toEqual({ wake: false, event: "skip-read-failed" });
	});
	test("a truncated read gets its own skip", async () => {
		const { w } = watch({
			read: async () => ({ items: [], state: "truncated", byMachine: false }),
			reportKey: () => undefined,
		});
		expect(await settleReport(w)).toEqual({ wake: false, event: "skip-read-truncated" });
	});
	test("nothing to report after a clean read is a plain skip", async () => {
		const { w } = watch({ reportKey: () => undefined });
		expect(await settleReport(w)).toEqual({ wake: false, event: "skip-report-superseded" });
	});
	test("an idle wake carries its work line", async () => {
		const { w } = watch({ reportKey: () => undefined, idleWork: async () => ({ key: "idle:s1", work: "open PR #1" }) });
		expect(await settleReport(w)).toMatchObject({ wake: true, key: "idle:s1", work: "open PR #1" });
	});
	test("an older card is noted, not a reason to stay quiet", async () => {
		const { w } = watch({
			state: () => ({ ...idle, status: "waiting", pendingRequestId: "old" }),
			oldCards: () => new Set(["old"]),
		});
		expect(await settleReport(w)).toMatchObject({ wake: true, oldCard: true });
	});
});

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
type Timeline = { name: string; runs: Run[]; items: (TurnItem & { runId: string })[]; pending: [string, number][] };
const timelines = (await Bun.file(new URL("./report.replay.json", import.meta.url)).json()) as Timeline[];

/**
 * A real thread's day through the real decisions, on a fake clock. Same order as Watcher.fire: a turn end is seen 3s
 * after the run stops, asks and stalls wake at once, and a report wake goes through settleReport. T3 reports no
 * background work during a run, so neither does this. Left out: cards, idle wakes, child threads, and how long reads take.
 */
async function replay(t: Timeline) {
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

describe("replay of a recorded timeline", () => {
	const named = (name: string) => timelines.find((t) => t.name === name) as Timeline;
	test("the #626 thread: 13 turn ends, one wake, after the last of them", async () => {
		// Its instruction was run 1 and 12 machine turns followed. Background work ran from 17:31:52 to 18:09:20.
		expect(await replay(named("build-626"))).toEqual([{ at: "18:12:30", key: "report:i1000001:machine" }]);
	});
	test("the Postgres thread: one wake for each of the Steward's four instructions", async () => {
		const wakes = await replay(named("postgres"));
		expect(wakes.map((x) => x.at)).toEqual(["13:43:45", "14:47:21", "16:38:35", "17:14:17"]);
		expect(wakes.every((x) => /^report:i\d+:0$/.test(x.key))).toBe(true);
	});
});

describe("a final report in a machine's turn", () => {
	test("wakes once after the instruction's own wake, and spends none of the three", () => {
		const fired = new Set(["report:s1:0"]);
		expect(reportKey([instruction], true, fired)).toBe("report:s1:machine");
		fired.add("report:s1:machine");
		expect(reportKey([instruction], true, fired)).toBeUndefined();
		expect(reportKey([instruction], false, fired)).toBe("report:s1:1");
	});
});

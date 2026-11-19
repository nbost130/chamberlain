/** A rig for the overhead tick's tests: a fake T3 that remembers what each seed became, and a ticker over an in-memory store with a clock the test moves. */
import { type Investigator, LaunchRefused, type ThreadState } from "../core/overhead/investigator.ts";
import { overheadTicker } from "../core/overhead/tick.ts";
import { type Investigation, isHeld, readOverheadState } from "../core/overhead/trigger.ts";
import * as fx from "./overhead-fixtures.ts";
import { cfgWith, MODEL, NOW } from "./overhead-fixtures.ts";
import { memStore } from "./store.ts";

export const inv = {
	enabled: true,
	model: { adapter: "t3", server: "s", instanceId: "p", model: "m", options: { effort: "high" } },
	projectId: "proj-1",
};
export const noop = { mode: "trigger", threshold: 0.1, minWakes: 5 };
export const crossing = (extra: Record<string, unknown> = {}) =>
	cfgWith({ enabled: true, investigator: inv, triggers: { noopRate: noop }, ...extra });

/** 10 wakes in the 24 h before `now`, 4 of them no-ops (40%). */
export const rows = (now = NOW) =>
	Array.from({ length: 10 }, (_, i) => fx.wake({ hoursAgo: 1 + i, usd: 2, tools: i < 4 ? 0 : 2, now }));

type UsageRow = ReturnType<typeof fx.wake>;

export type Thread = { briefSent: boolean; active: boolean; archived: boolean };

/** A T3 that remembers what each seed became, and can lose a response, refuse a launch, or fail to answer. */
export function fakeT3() {
	const threads = new Map<string, Thread>();
	const launched: { seed: string; title: string; brief: string }[] = [];
	const t3 = {
		threads,
		launched,
		/** After T3 accepts the thread and the brief, the response is lost. */
		loseResponse: false,
		/** The thread is made but the brief never arrives, then the response is lost. */
		loseBrief: false,
		refuse: false,
		inspectFails: false,
		investigator: {
			async launch(a) {
				launched.push(a);
				if (t3.refuse) throw new LaunchRefused("launch selection unavailable; nothing launched");
				const t = threads.get(a.seed) ?? { briefSent: false, active: true, archived: false };
				threads.set(a.seed, t);
				if (t3.loseBrief) throw Error("connection lost");
				t.briefSent = true;
				if (t3.loseResponse) throw Error("connection lost");
				return { threadId: `thread-${a.seed}` };
			},
			async inspect(seed): Promise<ThreadState> {
				if (t3.inspectFails) throw Error("T3 is not answering");
				const t = threads.get(seed);
				return t ? { exists: true, threadId: `thread-${seed}`, ...t } : { exists: false };
			},
		} satisfies Investigator,
	};
	return t3;
}

export type Rig = ReturnType<typeof rig>;

export function rig(
	o: {
		cfg?: ReturnType<typeof cfgWith>;
		t3?: ReturnType<typeof fakeT3>;
		investigator?: Investigator | null;
		gh?: () => Promise<unknown>;
		rows?: UsageRow[];
		store?: ReturnType<typeof memStore>;
	} = {},
) {
	const store = o.store ?? memStore();
	if (!o.store) store.usage.upsert(o.rows ?? rows());
	const t3 = o.t3 ?? fakeT3();
	const logs: { event: string; fields: Record<string, unknown> }[] = [];
	let now = NOW;
	let mono = 0;
	const make = () =>
		overheadTicker({
			store,
			cfg: o.cfg ?? crossing(),
			model: MODEL,
			gh: o.gh ?? (async () => ({ total: 0, incomplete: false, items: [] })),
			...(o.investigator === null ? {} : { investigator: o.investigator ?? t3.investigator }),
			commands: { note: "chamberlain note", close: "chamberlain overhead close", overhead: "chamberlain overhead" },
			now: () => now,
			mono: () => mono,
			log: (event, fields) => logs.push({ event, fields }),
		});
	let tick = make();
	const fresh = () => {
		if (!o.rows) store.usage.upsert(rows(now));
	};
	return {
		store,
		t3,
		logs,
		tick: () => tick(),
		/** A new ticker over the same store: the daemon restarted. */
		restart: () => {
			tick = make();
		},
		/** Time passes: the wall and the monotonic clock together. */
		advance: (ms: number) => {
			now += ms;
			mono += ms;
			fresh();
		},
		/** The wall clock jumps and the monotonic clock does not. */
		jump: (ms: number) => {
			now += ms;
			fresh();
		},
		at: () => now,
	};
}

export const stateOf = (r: Rig) => readOverheadState(r.store);
export const heldOf = (r: Rig): Investigation[] => stateOf(r).investigations.filter(isHeld);

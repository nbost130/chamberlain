import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { normalizeThread, type LastAssistant, type ThreadInput } from "./adapter.ts";
import {
	EXCERPT_CHARS,
	IDLE_PARENTS_DEFAULTS,
	IDLE_PARENTS_SOURCE,
	excerptOf,
	idleKey,
	idlePrior,
	idleParentCandidate,
	idleParentFindings,
	idleParentsSource,
	messageHash,
	parseIdleParents,
	selectIdleThreads,
	type IdleSelection,
	type IdleThread,
	type IdleThreadSource,
} from "./idle-parents.ts";
import { runSource } from "./source.ts";
import { parseSweepConfig } from "./sweep.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const thread = (over: Partial<ThreadInput> = {}) => normalizeThread({ id: "t", title: "T", status: "idle", ...over });
const last = (id: string, minutesIdle: number, text = "All done."): LastAssistant => ({
	id,
	text,
	at: new Date(NOW - minutesIdle * MIN).toISOString(),
});
/** A source of threads: each entry is a thread and its last message; `bad` threads throw when read. */
function source(
	entries: { th: ThreadInput; last?: LastAssistant; bad?: boolean }[],
	o: {
		server?: string;
		connected?: boolean;
		children?: Record<string, number>;
		subagents?: Record<string, number | Error>;
		noRead?: boolean;
	} = {},
): IdleThreadSource & { failures: string[] } {
	const failures: string[] = [];
	const byId = new Map(entries.map((e) => [e.th.id, e]));
	return {
		server: o.server ?? "main",
		connected: o.connected ?? true,
		threads: entries.map((e) => normalizeThread(e.th)),
		liveChildren: (id) => o.children?.[id] ?? 0,
		...(o.noRead
			? {}
			: {
					lastAssistant: async (id: string) => {
						const e = byId.get(id)!;
						if (e.bad) throw Error("projection failed");
						return e.last;
					},
				}),
		...(o.subagents
			? {
					runningSubagents: async (id: string) => {
						const n = o.subagents![id] ?? 0;
						if (n instanceof Error) throw n;
						return n;
					},
				}
			: {}),
		readFailed: (id) => failures.push(id),
		failures,
	};
}
const idle = (id: string, minutesIdle: number, text = "All done.", over: Partial<ThreadInput> = {}) => ({
	th: { id, title: `Thread ${id}`, status: "idle", ...over },
	last: last(`m-${id}`, minutesIdle, text),
});
const rec = (id: string, minutesIdle: number, text = "All done.", server = "main"): IdleThread => {
	const l = last(`m-${id}`, minutesIdle, text);
	return {
		server,
		threadId: id,
		title: `Thread ${id}`,
		idleMinutes: minutesIdle,
		lastMessage: text,
		lastMessageHash: messageHash(l),
		looksLikeAsk: /go|\?/.test(text),
	};
};
const sel = (threads: IdleThread[], unreadable: IdleSelection["unreadable"] = []): IdleSelection => ({
	threads,
	unreadable,
});
const CFG = IDLE_PARENTS_DEFAULTS;

describe("the idle-parents config", () => {
	test("defaults: on, every 15 minutes, idle for 30 minutes, 10 threads", () => {
		const d = { enabled: true, intervalMinutes: 15, thresholdMinutes: 30, maxThreads: 10 };
		expect(parseIdleParents(undefined)).toEqual(d);
		expect(parseIdleParents({})).toEqual(d);
	});
	test("each setting can be given", () =>
		expect(parseIdleParents({ enabled: false, intervalMinutes: 5, thresholdMinutes: 90, maxThreads: 3 })).toEqual({
			enabled: false,
			intervalMinutes: 5,
			thresholdMinutes: 90,
			maxThreads: 3,
		}));
	test("bad values and unknown keys are refused, never ignored", () => {
		expect(() => parseIdleParents([])).toThrow("expected an object");
		expect(() => parseIdleParents({ enabled: "yes" })).toThrow("enabled must be true or false");
		expect(() => parseIdleParents({ thresholdMinutes: 0 })).toThrow("thresholdMinutes must be a positive number");
		expect(() => parseIdleParents({ intervalMinutes: 0 })).toThrow("intervalMinutes must be a positive number");
		expect(() => parseIdleParents({ intervalMinutes: "15" })).toThrow("intervalMinutes");
		expect(() => parseIdleParents({ maxThreads: 2.5 })).toThrow("maxThreads must be a positive whole number");
		expect(() => parseIdleParents({ maxThreads: -1 })).toThrow("maxThreads");
		expect(() => parseIdleParents({ thresholdMin: 5 })).toThrow('unknown key "thresholdMin"');
	});
	test("the sweep section carries it, needs no checks to tune it, and keeps its name for itself", () => {
		expect(parseSweepConfig({ idleParents: { thresholdMinutes: 45 } })).toMatchObject({
			checks: [],
			idleParents: { enabled: true, intervalMinutes: 15, thresholdMinutes: 45, maxThreads: 10 },
		});
		expect(() => parseSweepConfig({ checks: [{ name: "idle-parents", command: ["x"] }] })).toThrow("built-in");
		expect(() => parseSweepConfig({ checks: [], idleParents: { maxThreads: 0 } })).toThrow("maxThreads");
	});
});

describe("which threads can be idle parents", () => {
	const none = new Set<string>();
	test("an idle or completed top-level thread can", () => {
		expect(idleParentCandidate(thread({ status: "idle" }), none)).toBe(true);
		expect(idleParentCandidate(thread({ status: "completed" }), none)).toBe(true);
	});
	test("a child or subagent thread cannot", () =>
		expect(idleParentCandidate(thread({ parentThreadId: "p" }), none)).toBe(false));
	test("a settled, snoozed or archived thread cannot", () => {
		expect(idleParentCandidate(thread({ settled: true }), none)).toBe(false);
		expect(idleParentCandidate(thread({ snoozed: true }), none)).toBe(false);
		expect(idleParentCandidate(thread({ archived: true }), none)).toBe(false);
	});
	test("a thread that is working, waiting, failed or interrupted is not idle", () => {
		for (const status of ["running", "queued", "starting", "preparing", "waiting", "failed", "interrupted"])
			expect(idleParentCandidate(thread({ status }), none)).toBe(false);
	});
	test("a thread with an open card, a background task or a running child is not idle", () => {
		expect(idleParentCandidate(thread({ pendingRequestId: "r1" }), none)).toBe(false);
		expect(idleParentCandidate(thread({ backgroundTasks: 1 }), none)).toBe(false);
		expect(idleParentCandidate(thread(), none, 1)).toBe(false);
	});
	test("a thread on the skip list (the Steward's own and the like) cannot", () =>
		expect(idleParentCandidate(thread({ id: "steward" }), new Set(["steward"]))).toBe(false));
});

describe("selectIdleThreads: the one selection, as plain records", () => {
	test("a record carries server, threadId, title, idleMinutes, lastMessage, lastMessageHash and looksLikeAsk", async () => {
		const l = last("m-a", 125, "The endpoint is not built. Say go and I'll start it.");
		const r = await selectIdleThreads(
			[source([{ th: { id: "a", title: "Build it", status: "idle" }, last: l }])],
			NOW,
			{
				thresholdMinutes: 30,
			},
		);
		expect(r).toEqual({
			threads: [
				{
					server: "main",
					threadId: "a",
					title: "Build it",
					idleMinutes: 125,
					lastMessage: l.text,
					lastMessageHash: messageHash(l),
					looksLikeAsk: true,
				},
			],
			unreadable: [],
		});
	});
	test("only a thread idle for MORE than the threshold is selected", async () => {
		const r = await selectIdleThreads([source([idle("a", 29), idle("b", 30), idle("c", 31), idle("d", 300)])], NOW, {
			thresholdMinutes: 30,
		});
		expect(r.threads.map((t) => t.threadId)).toEqual(["d", "c"]);
	});
	test("a thread that is not an idle parent is never selected", async () => {
		const src = source(
			[
				idle("ok", 90),
				idle("child", 90, "x", { parentThreadId: "ok" }),
				idle("settled", 90, "x", { settled: true }),
				idle("snoozed", 90, "x", { snoozed: true }),
				idle("archived", 90, "x", { archived: true }),
				idle("running", 90, "x", { status: "running" }),
				idle("waiting", 90, "x", { status: "waiting" }),
				idle("card", 90, "x", { pendingRequestId: "r1" }),
				idle("bg", 90, "x", { backgroundTasks: 2 }),
				idle("kids", 90, "x"),
				idle("steward", 90, "x"),
				idle("done", 90, "x", { status: "completed" }),
			],
			{ children: { kids: 1 } },
		);
		const r = await selectIdleThreads([src], NOW, { thresholdMinutes: 30, skip: new Set(["steward"]) });
		expect(r.threads.map((t) => t.threadId).sort()).toEqual(["done", "ok"]);
		expect(r.unreadable).toEqual([]);
	});
	test("asks come first, then the longest idle, across servers", async () => {
		const r = await selectIdleThreads(
			[
				source([idle("plain-old", 600), idle("ask-new", 70, "Say go and I'll start it.")], { server: "one" }),
				source([idle("plain-new", 90), idle("ask-old", 400, "Want me to merge it?")], { server: "two" }),
			],
			NOW,
			{ thresholdMinutes: 30 },
		);
		expect(r.threads.map((t) => `${t.server}/${t.threadId}`)).toEqual([
			"two/ask-old",
			"one/ask-new",
			"one/plain-old",
			"two/plain-new",
		]);
		expect(r.threads.map((t) => t.looksLikeAsk)).toEqual([true, true, false, false]);
	});
	test("an ask is judged on the whole last message, a go-phrase in the closing line included", async () => {
		const r = await selectIdleThreads(
			[source([idle("a", 90, "Token installed.\n\n🗣️ Say go and I'll start it.")])],
			NOW,
			{ thresholdMinutes: 30 },
		);
		expect(r.threads[0]!.looksLikeAsk).toBe(true);
	});
	test("a read that throws, and a server that is not connected, are unreadable, never cleared", async () => {
		const failing = source([idle("ok", 90), { ...idle("bad", 90), bad: true }]);
		const r = await selectIdleThreads([failing], NOW, { thresholdMinutes: 30 });
		expect(r.threads.map((t) => t.threadId)).toEqual(["ok"]);
		expect(r.unreadable).toEqual([{ server: "main", threadId: "bad" }]);
		expect(failing.failures).toEqual(["bad"]);
		const down = await selectIdleThreads([source([idle("a", 90)], { connected: false })], NOW, {
			thresholdMinutes: 30,
		});
		expect(down).toEqual({ threads: [], unreadable: [{ server: "main", threadId: "a" }] });
	});
	test("a parent with running subagents the inspector reports (and the thread table does not) is not idle (a review finding)", async () => {
		const src = source([idle("busy", 90), idle("free", 90), idle("unsure", 90)], {
			subagents: { busy: 2, unsure: Error("projection failed") },
		});
		const r = await selectIdleThreads([src], NOW, { thresholdMinutes: 30 });
		expect(r.threads.map((t) => t.threadId)).toEqual(["free"]);
		// A subagent count that cannot be read is unreadable, never "none running".
		expect(r.unreadable).toEqual([{ server: "main", threadId: "unsure" }]);
		expect(src.failures).toEqual(["unsure"]);
	});
	test("an adapter that cannot read last messages selects nothing", async () => {
		const r = await selectIdleThreads([source([idle("a", 90)], { noRead: true })], NOW, { thresholdMinutes: 30 });
		expect(r).toEqual({ threads: [], unreadable: [] });
	});
	test("a thread with no message, or none with a usable time, is not selected", async () => {
		const r = await selectIdleThreads(
			[
				source([
					{ th: { id: "a", title: "A", status: "idle" } },
					{ th: { id: "b", title: "B", status: "idle" }, last: { id: "m", text: "x", at: "soon" } },
				]),
			],
			NOW,
			{ thresholdMinutes: 30 },
		);
		expect(r.threads).toEqual([]);
	});
	test("more threads than one batch are all read", async () => {
		const many = Array.from({ length: 21 }, (_, i) => idle(`t${i}`, 100 + i));
		const r = await selectIdleThreads([source(many)], NOW, { thresholdMinutes: 30 });
		expect(r.threads).toHaveLength(21);
	});
});

describe("the findings", () => {
	test("a finding names the server, thread id, title, idle minutes and the last message", () => {
		const [f] = idleParentFindings(sel([rec("t9", 125, "Built it.")]), CFG);
		expect(f!.text).toBe('thread "Thread t9" on main (threadId t9), idle 125 min. Last message: Built it.');
	});
	test("an ask is marked, and the mark is first on the line", () => {
		const [f] = idleParentFindings(sel([rec("a", 90, "Say go.")]), CFG);
		expect(f!.text.startsWith("[ASKING] ")).toBe(true);
	});
	test("the last message is cut to its end, whitespace collapsed", () => {
		const long = `${"x".repeat(500)}\n\n   Say go.`;
		const out = excerptOf(long);
		expect(out.startsWith("…")).toBe(true);
		expect(out.endsWith("xxx Say go.")).toBe(true);
		expect(out.length).toBe(EXCERPT_CHARS + 1);
		expect(excerptOf("short  one")).toBe("short one");
	});
	test("the key is the thread plus a hash of its last message", () => {
		const a = rec("a", 90, "one");
		expect(idleKey(a)).toBe(`main:a:${messageHash(last("m-a", 90, "one"))}`);
		expect(idleKey(rec("a", 120, "one"))).toBe(idleKey(a));
		expect(idleKey(rec("a", 90, "two"))).not.toBe(idleKey(a));
		expect(messageHash({ id: "m-2", text: "one" })).not.toBe(messageHash({ id: "m-a", text: "one" }));
	});
	test("the cap limits NEW threads, in order, and never drops one already open", () => {
		const threads = [rec("ask", 100, "Shall I go?"), rec("a", 500), rec("b", 400), rec("c", 300)];
		const cfg = { maxThreads: 2 };
		expect(idleParentFindings(sel(threads), cfg).map((x) => x.dedupKey.split(":")[1])).toEqual(["ask", "a"]);
		// With "c" already open it stays listed (or the item system would report it again), and the cap still counts only the new ones.
		const c = idleParentFindings(sel([threads[3]!]), cfg)[0]!;
		const again = idleParentFindings(sel(threads), cfg, [{ dedupKey: c.dedupKey, text: c.text }]);
		expect(again.map((x) => x.dedupKey.split(":")[1]).sort()).toEqual(["a", "ask", "c"]);
	});
	test("a thread that could not be read keeps its open finding; one that was read and moved on does not", () => {
		const a = idleParentFindings(sel([rec("a", 90)]), CFG)[0]!;
		const prior = [{ dedupKey: a.dedupKey, text: a.text }];
		expect(idleParentFindings(sel([], [{ server: "main", threadId: "a" }]), CFG, prior)).toEqual([a]);
		expect(idleParentFindings(sel([], [{ server: "main", threadId: "other" }]), CFG, prior)).toEqual([]);
		expect(idleParentFindings(sel([]), CFG, prior)).toEqual([]);
	});
});

describe("through the item system: one report per thread and last message", () => {
	/** One tick of the check over what the threads say then. */
	const tick = (
		store: ReturnType<typeof memStore>,
		threads: IdleThread[],
		cfg = CFG,
		unreadable: IdleSelection["unreadable"] = [],
	) =>
		runSource(
			store,
			idleParentsSource({
				cfg,
				select: async () => sel(threads, unreadable),
				prior: () => idlePrior(store),
			}),
			{ now: NOW },
		);
	const ids = (o: { notified: { payload: Record<string, unknown> }[] }) =>
		o.notified.map((i) => String(i.payload.text).match(/threadId (\w+)/)![1]);

	test("a thread is reported once across ticks, and again only when its last message changes", async () => {
		const store = memStore();
		expect(ids(await tick(store, [rec("a", 90, "Say go.")]))).toEqual(["a"]);
		// The same message on later ticks, ever more idle: never reported again.
		for (const m of [105, 120, 600]) expect((await tick(store, [rec("a", m, "Say go.")])).notified).toEqual([]);
		// A new last message is a new finding.
		const next = await tick(store, [rec("a", 40, "Merged.")]);
		expect(ids(next)).toEqual(["a"]);
		expect(String(next.notified[0]!.payload.text)).toContain("Merged.");
		// And that one holds across ticks too.
		expect((await tick(store, [rec("a", 55, "Merged.")])).notified).toEqual([]);
	});
	test("a thread that was unreadable for one tick is not reported again when it returns unchanged", async () => {
		const store = memStore();
		await tick(store, [rec("a", 90)]);
		expect((await tick(store, [], CFG, [{ server: "main", threadId: "a" }])).notified).toEqual([]);
		expect((await tick(store, [rec("a", 110)])).notified).toEqual([]);
	});
	test("a thread that goes ineligible and comes back with the same last message is reported once in all (a review finding)", async () => {
		const store = memStore();
		const a = rec("a", 90, "Say go.");
		// Present, present, away (snoozed), back, away (briefly running), back: one report, not three.
		const table = [[a], [a], [], [a], [], [a]];
		const sent: number[] = [];
		for (const threads of table) sent.push((await tick(store, threads)).notified.length);
		expect(sent).toEqual([1, 0, 0, 0, 0, 0]);
		// And a new last message after all that is still news.
		expect((await tick(store, [rec("a", 20, "Merged.")])).notified).toHaveLength(1);
	});
	test("a thread away for a tick does not count against the cap when it returns", async () => {
		const store = memStore();
		const cfg = { ...CFG, maxThreads: 1 };
		const a = rec("a", 200);
		const b = rec("b", 100);
		expect(ids(await tick(store, [a], cfg))).toEqual(["a"]);
		await tick(store, [], cfg);
		// "a" returns unchanged alongside a new "b": only "b" is news, and it fits the cap of one.
		expect(ids(await tick(store, [a, b], cfg))).toEqual(["b"]);
	});
	test("with several, asks go first and the cap holds the rest for a later tick, nobody twice", async () => {
		const store = memStore();
		const cfg = { ...CFG, maxThreads: 2 };
		const all = [rec("ask", 100, "Say go and I'll start it."), rec("p1", 300), rec("p2", 200)];
		expect(ids(await tick(store, all, cfg))).toEqual(["ask", "p1"]);
		expect(ids(await tick(store, all, cfg))).toEqual(["p2"]);
		expect((await tick(store, all, cfg)).notified).toEqual([]);
	});
});

import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { normalizeThread, type ThreadInput } from "./adapter.ts";
import {
	EXCERPT_CHARS,
	IDLE_PARENTS_DEFAULTS,
	IDLE_PARENTS_SOURCE,
	excerptOf,
	idleParentCandidate,
	idleParentFindings,
	idleParentsSource,
	messageHash,
	parseIdleParents,
	type IdleParentFact,
	type IdleParentsRead,
} from "./idle-parents.ts";
import { runSource } from "./source.ts";
import { parseSweepConfig } from "./sweep.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const CFG = IDLE_PARENTS_DEFAULTS;
const fact = (
	id: string,
	minutesIdle: number,
	text = "All done.",
	over: Partial<IdleParentFact> = {},
): IdleParentFact => ({
	server: "main",
	id,
	title: `Thread ${id}`,
	last: { id: `m-${id}`, text, at: new Date(NOW - minutesIdle * MIN).toISOString() },
	at: NOW - minutesIdle * MIN,
	...over,
});
const read = (facts: IdleParentFact[], unreadable: IdleParentsRead["unreadable"] = []): IdleParentsRead => ({
	facts,
	unreadable,
});
const thread = (over: Partial<ThreadInput> = {}) => normalizeThread({ id: "t", title: "T", status: "idle", ...over });

describe("the idle-parents config", () => {
	test("defaults: on, 60 minutes, 10 threads", () => {
		expect(parseIdleParents(undefined)).toEqual({ enabled: true, thresholdMinutes: 60, maxThreads: 10 });
		expect(parseIdleParents({})).toEqual({ enabled: true, thresholdMinutes: 60, maxThreads: 10 });
	});
	test("each setting can be given", () =>
		expect(parseIdleParents({ enabled: false, thresholdMinutes: 90, maxThreads: 3 })).toEqual({
			enabled: false,
			thresholdMinutes: 90,
			maxThreads: 3,
		}));
	test("bad values and unknown keys are refused, never ignored", () => {
		expect(() => parseIdleParents([])).toThrow("expected an object");
		expect(() => parseIdleParents({ enabled: "yes" })).toThrow("enabled must be true or false");
		expect(() => parseIdleParents({ thresholdMinutes: 0 })).toThrow("thresholdMinutes must be a positive number");
		expect(() => parseIdleParents({ maxThreads: 2.5 })).toThrow("maxThreads must be a positive whole number");
		expect(() => parseIdleParents({ maxThreads: -1 })).toThrow("maxThreads");
		expect(() => parseIdleParents({ thresholdMin: 5 })).toThrow('unknown key "thresholdMin"');
	});
	test("the sweep section carries it, needs no checks to tune it, and keeps its name for itself", () => {
		expect(parseSweepConfig({ idleParents: { thresholdMinutes: 45 } })).toMatchObject({
			checks: [],
			idleParents: { enabled: true, thresholdMinutes: 45, maxThreads: 10 },
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

describe("the findings", () => {
	test("only a thread idle for MORE than the threshold is listed", () => {
		const f = idleParentFindings(read([fact("a", 59), fact("b", 60), fact("c", 61), fact("d", 300)]), NOW, CFG);
		expect(f.map((x) => x.dedupKey.split(":")[1])).toEqual(["d", "c"]);
	});
	test("a finding names the server, thread id, title, idle minutes and the last message", () => {
		const [f] = idleParentFindings(read([fact("t9", 125, "Built it.")]), NOW, CFG);
		expect(f!.text).toBe('thread "Thread t9" on main (threadId t9), idle 125 min. Last message: Built it.');
	});
	test("asks come first, then the longest idle", () => {
		const f = idleParentFindings(
			read([
				fact("plain-old", 600),
				fact("ask-new", 70, "The endpoint is not built. Say go and I'll start it."),
				fact("plain-new", 90),
				fact("ask-old", 400, "Want me to merge it?"),
			]),
			NOW,
			CFG,
		);
		expect(f.map((x) => x.dedupKey.split(":")[1])).toEqual(["ask-old", "ask-new", "plain-old", "plain-new"]);
		expect(f[0]!.text.startsWith("[ASKING] ")).toBe(true);
		expect(f[2]!.text.startsWith("[ASKING]")).toBe(false);
	});
	test("an ask is judged on the whole last message, a go-phrase in the closing line included", () => {
		const [f] = idleParentFindings(read([fact("a", 90, "Token installed.\n\n🗣️ Say go and I'll start it.")]), NOW, CFG);
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
		const a = fact("a", 90, "one");
		const same = fact("a", 120, "one");
		const edited = fact("a", 90, "two");
		const next = fact("a", 90, "one", { last: { id: "m-next", text: "one", at: a.last.at } });
		const key = (x: IdleParentFact) => idleParentFindings(read([x]), NOW, CFG)[0]!.dedupKey;
		expect(key(a)).toBe(`main:a:${messageHash(a.last)}`);
		expect(key(same)).toBe(key(a));
		expect(key(edited)).not.toBe(key(a));
		expect(key(next)).not.toBe(key(a));
	});
	test("the cap limits NEW threads, in order, and never drops one already open", () => {
		const facts = [fact("a", 500), fact("b", 400), fact("c", 300), fact("ask", 100, "Shall I go?")];
		const cfg = { ...CFG, maxThreads: 2 };
		// Nothing open yet: the ask and the oldest plain thread.
		const first = idleParentFindings(read(facts), NOW, cfg);
		expect(first.map((x) => x.dedupKey.split(":")[1])).toEqual(["ask", "a"]);
		// With "c" already open it stays listed (or the item system would report it again), and the cap still counts only the new ones.
		const c = idleParentFindings(read([facts[2]!]), NOW, cfg)[0]!;
		const again = idleParentFindings(read(facts), NOW, cfg, [{ dedupKey: c.dedupKey, text: c.text }]);
		expect(again.map((x) => x.dedupKey.split(":")[1]).sort()).toEqual(["a", "ask", "c"]);
	});
	test("a thread that could not be read keeps its open finding; one that was read and moved on does not", () => {
		const a = idleParentFindings(read([fact("a", 90)]), NOW, CFG)[0]!;
		const prior = [{ dedupKey: a.dedupKey, text: a.text }];
		expect(idleParentFindings(read([], [{ server: "main", id: "a" }]), NOW, CFG, prior)).toEqual([a]);
		expect(idleParentFindings(read([], [{ server: "main", id: "other" }]), NOW, CFG, prior)).toEqual([]);
		expect(idleParentFindings(read([]), NOW, CFG, prior)).toEqual([]);
	});
});

describe("through the item system: one report per thread and last message", () => {
	const run = (store: ReturnType<typeof memStore>, facts: IdleParentFact[], now = NOW, cfg = CFG) =>
		runSource(
			store,
			idleParentsSource({
				cfg,
				gather: async () => read(facts),
				prior: () =>
					store.items
						.list({ source: IDLE_PARENTS_SOURCE, status: ["triggered", "acknowledged"] })
						.map((i) => ({ dedupKey: i.dedupKey, text: String(i.payload.text) })),
				now: () => now,
			}),
			{ now },
		);
	const texts = (o: { notified: { payload: Record<string, unknown> }[] }) =>
		o.notified.map((i) => String(i.payload.text));

	test("a thread is reported once, and again only when its last message changes", async () => {
		const store = memStore();
		const first = await run(store, [fact("a", 90, "Say go.")]);
		expect(texts(first)).toHaveLength(1);
		// Same message an hour later (more idle minutes): not reported again.
		expect((await run(store, [fact("a", 150, "Say go.")], NOW + 60 * MIN)).notified).toEqual([]);
		expect((await run(store, [fact("a", 210, "Say go.")], NOW + 120 * MIN)).notified).toEqual([]);
		// A new last message is a new finding.
		const next = await run(store, [
			fact("a", 80, "Merged.", { last: { id: "m-2", text: "Merged.", at: new Date(NOW).toISOString() } }),
		]);
		expect(texts(next)).toHaveLength(1);
		expect(texts(next)[0]).toContain("Merged.");
	});
	test("with several, the wake lists them asks first and the cap holds the rest for a later sweep", async () => {
		const store = memStore();
		const cfg = { ...CFG, maxThreads: 2 };
		const facts = [fact("p1", 300), fact("p2", 200), fact("ask", 100, "Say go and I'll start it.")];
		const a = await run(store, facts, NOW, cfg);
		expect(texts(a).map((t) => t.match(/threadId (\w+)/)![1])).toEqual(["ask", "p1"]);
		// The next sweep reports the one that was held back, and nobody twice.
		const b = await run(store, facts, NOW + 120 * MIN, cfg);
		expect(texts(b).map((t) => t.match(/threadId (\w+)/)![1])).toEqual(["p2"]);
		expect((await run(store, facts, NOW + 240 * MIN, cfg)).notified).toEqual([]);
	});
});

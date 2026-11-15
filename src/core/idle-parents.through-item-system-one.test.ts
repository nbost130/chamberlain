/** idle-parents, continued: see idle-parents.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { CFG, last, NOW, rec, sel, source } from "../testing/core-idle-parents-fixtures.ts";
import { memStore } from "../testing/store.ts";
import type { LastAssistant } from "./adapter-inspect.ts";
import type { Classified } from "./classifier/classify.ts";
import {
	classTag,
	digestText,
	excerptOf,
	type IdleClassification,
	idleKey,
	idleParentFindings,
	idleParentsSource,
	idlePrior,
	idleText,
} from "./idle-parents.ts";
import { type IdleSelection, type IdleThread, selectIdleThreads } from "./idle-select.ts";
import { runSource } from "./source.ts";

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

describe("selectIdleThreads: who wrote the message before the last one", () => {
	test("a human's message, an agent's, or none, from the same read", async () => {
		const withPrev = (id: string, previous?: LastAssistant["previous"]) => ({
			th: { id, title: `Thread ${id}`, status: "idle" },
			last: { ...last(`m-${id}`, 90, "Half of it is done."), ...(previous ? { previous } : {}) },
		});
		const r = await selectIdleThreads(
			[
				source([
					withPrev("h", { by: "human", text: "which tabs use the memory?" }),
					withPrev("a", { by: "agent", text: "continue" }),
					withPrev("n"),
				]),
			],
			NOW,
			{ thresholdMinutes: 30 },
		);
		const prev = Object.fromEntries(r.threads.map((t) => [t.threadId, t.previous]));
		expect(prev).toEqual({
			h: { from: "human", text: "which tabs use the memory?" },
			a: { from: "agent", text: "continue" },
			n: { from: "none", text: "" },
		});
	});
});

describe("the findings with a classifier", () => {
	const cls = (mode: "shadow" | "live", by: Record<string, Classified>): IdleClassification => ({
		mode,
		day: "2026-11-14",
		byKey: new Map(Object.entries(by)),
	});
	const esc: Classified = { action: "escalate", reasons: [{ id: "asks_decision", p: 0.98 }] };
	const ndg: Classified = { action: "nudge", reasons: [{ id: "partial_answer", p: 0.97 }] };
	const stl: Classified = { action: "settle", reasons: [{ id: "work_finished", p: 0.96 }] };
	const ign: Classified = { action: "ignore", reasons: [] };
	const unk: Classified = { action: "unknown", reasons: [], error: "Jev answered HTTP 503" };
	const threads = [
		rec("e", 540, "Say go and I'll start it."),
		rec("n", 566, "I can't say which ones account for it."),
		rec("s", 900, "Merged and deployed."),
		rec("i", 60, "The watch stays on."),
		rec("u", 30, "Something."),
		rec("x", 1000, "Not classified at all."),
	];
	const by = (t: IdleThread) => idleKey(t);
	const all = {
		[by(threads[0]!)]: esc,
		[by(threads[1]!)]: ndg,
		[by(threads[2]!)]: stl,
		[by(threads[3]!)]: ign,
		[by(threads[4]!)]: unk,
	};

	test("shadow: the report is exactly as without a classifier", () =>
		expect(idleParentFindings(sel(threads), CFG, [], cls("shadow", all))).toEqual(
			idleParentFindings(sel(threads), CFG),
		));

	test("live: escalate, then nudge, then unknown (including unclassified), by idle time; ignore and settle are not reported", () => {
		const f = idleParentFindings(sel(threads), CFG, [], cls("live", all));
		expect(f.map((x) => x.dedupKey)).toEqual([
			by(threads[0]!),
			by(threads[1]!),
			by(threads[5]!),
			by(threads[4]!),
			"settled-digest:2026-11-14",
		]);
		expect(f[0]!.text).toStartWith(
			'[ESCALATE asks_decision 0.98] thread "Thread e" on main (threadId e), idle 540 min. Last message: ',
		);
		expect(f[1]!.text).toStartWith("[NUDGE partial_answer 0.97] thread");
		// Unknown and unclassified read exactly as without the classifier: a failure never silences or changes the report.
		expect(f[2]!.text).toBe(idleText(threads[5]!));
		expect(f[3]!.text).toBe(idleText(threads[4]!));
	});

	test("the tag lists every question that fired, strongest first", () =>
		expect(
			classTag({
				action: "escalate",
				reasons: [
					{ id: "asks_decision", p: 0.981 },
					{ id: "needs_principal_task", p: 0.6 },
				],
			}),
		).toBe("[ESCALATE asks_decision 0.98, needs_principal_task 0.60]"));

	test("live: the settled threads go into one digest line a day, not one line each", () => {
		const f = idleParentFindings(sel(threads), CFG, [], cls("live", all));
		const digest = f.find((x) => x.dedupKey === "settled-digest:2026-11-14")!;
		expect(digest.text).toBe(
			'1 idle thread looks finished (the classifier\'s settle; not reported one by one): "Thread s" on main.',
		);
		// Already sent today: not again, however many settle.
		const prior = [{ dedupKey: "settled-digest:2026-11-14", text: digest.text, resolved: true }];
		expect(
			idleParentFindings(sel(threads), CFG, prior, cls("live", all)).some((x) => x.dedupKey.startsWith("settled")),
		).toBe(false);
		// Many: the first twelve by name, then a count.
		const many = Array.from({ length: 15 }, (_, i) => rec(`s${i}`, 100 + i));
		const text = digestText(many);
		expect(text).toStartWith("15 idle threads look finished");
		expect(text).toEndWith(", and 3 more.");
		// No settled thread: no digest.
		expect(
			idleParentFindings(sel([threads[0]!]), CFG, [], cls("live", all)).some((x) => x.dedupKey.startsWith("settled")),
		).toBe(false);
	});

	test("live: the cap counts only reported threads, in the live order", () => {
		const f = idleParentFindings(sel(threads), { maxThreads: 1, repeatHours: 2 }, [], cls("live", all));
		expect(f.map((x) => x.dedupKey)).toEqual([by(threads[0]!), "settled-digest:2026-11-14"]);
	});

	test("the source runs the classifier between the selection and the findings, and only when it is given one", async () => {
		const store = memStore();
		const seen: IdleThread[][] = [];
		const findings = await runSource(
			store,
			idleParentsSource({
				cfg: CFG,
				select: async () => sel(threads.slice(0, 3)),
				prior: () => idlePrior(store),
				classify: async (ts) => {
					seen.push([...ts]);
					return cls("live", all);
				},
			}),
			{ now: NOW },
		);
		expect(seen[0]!.map((t) => t.threadId)).toEqual(["e", "n", "s"]);
		expect(findings.notified.map((i) => String(i.payload.text).slice(0, 9))).toEqual([
			"[ESCALATE",
			"[NUDGE pa",
			"1 idle th",
		]);
	});

	test("excerpts and titles cut through an emoji stay well formed", () => {
		expect(excerptOf(`${"x".repeat(10)}🙂${"y".repeat(299)}`).isWellFormed()).toBe(true);
		expect(idleText(rec("t", 60, `🙂${"y".repeat(299)}`)).isWellFormed()).toBe(true);
		const t = { ...rec("t", 60), title: `${"a".repeat(78)}🙂🙂` };
		expect(idleText(t).isWellFormed()).toBe(true);
	});
});

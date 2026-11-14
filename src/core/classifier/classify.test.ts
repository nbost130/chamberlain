import { describe, expect, test } from "bun:test";
import {
	CANARY,
	cfg,
	deps,
	fakeProvider,
	key,
	NOW,
	no,
	thread,
} from "../../testing/core-classifier-classify-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { DEFAULT_BANK } from "./bank.ts";
import { bankVersion, classifyIdle } from "./classify.ts";
import { utcDayStart } from "./classify-budget.ts";

describe("classifyIdle", () => {
	test("off (provider none): no call, no row, an empty map", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider();
		const { d } = deps(s, provider);
		expect((await classifyIdle([thread("a")], cfg({ provider: "none" }), d)).size).toBe(0);
		expect(sent).toEqual([]);
		expect(s.dispositions.usage(0, ["jev", "haiku", "rules"])).toEqual({ calls: 0, usd: 0 });
	});

	test("one call per thread; the decision, the probabilities that fired, and a row that holds no message text", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider();
		const { d, logs } = deps(s, provider);
		const c = cfg();
		const t = thread("a");
		const out = await classifyIdle([t], c, d);
		expect(out.get(key(t))).toEqual({ action: "escalate", reasons: [{ id: "asks_decision", p: 0.98 }] });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.previous_message.from).toBe("human");
		const version = bankVersion(DEFAULT_BANK, c, "jev-1.14.0");
		const row = s.dispositions.get({ server: "main", threadId: "a", messageHash: "h-a", bankVersion: version })!;
		expect(row).toMatchObject({
			classifiedAt: NOW,
			provider: "jev",
			model: "jev-1.14.0",
			mode: "shadow",
			action: "escalate",
			reasons: ["asks_decision"],
			answers: { ...no, asks_decision: 0.98 },
			idleMinutes: 120,
			sentChars: sent[0]!.last_message.length + sent[0]!.previous_message.text.length + sent[0]!.thread_title!.length,
			redactions: 0,
			inputTokens: 1717,
			costUsd: 0.000072,
			latencyMs: 104,
			error: null,
			feedback: null,
			correctedAction: null,
		});
		// No column of the row holds any of the thread's text, and neither does the log.
		expect(JSON.stringify(row)).not.toContain(CANARY);
		expect(JSON.stringify(logs)).not.toContain(CANARY);
		expect(logs.find((l) => l.event === "classifier")?.data).toMatchObject({ provider: "jev", calls: 1, escalate: 1 });
	});

	test("the cache: the same message and bank makes no second call; a new message, or a changed bank, classifies again", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider();
		const { d } = deps(s, provider);
		const c = cfg();
		await classifyIdle([thread("a")], c, d);
		for (let n = 0; n < 3; n++) await classifyIdle([thread("a")], c, d);
		expect(sent).toHaveLength(1);
		await classifyIdle([thread("a", { lastMessageHash: "h-a2" })], c, d);
		expect(sent).toHaveLength(2);
		// Any of the bank, the thresholds, the model, the send or redact settings is a new bank version.
		for (const over of [
			{ thresholds: { default: 0.6 } },
			{ send: { ...c.send, lastChars: 900 } },
			{ redact: { builtin: false, command: null } },
		])
			await classifyIdle([thread("a")], cfg(over), d);
		expect(sent).toHaveLength(5);
		// A new pinned model is a new bank version: one call to it, and a row under the new version.
		const moved = fakeProvider(undefined, { model: "jev-1.15.0" });
		await classifyIdle([thread("a")], c, deps(s, moved.provider).d);
		expect(moved.sent).toHaveLength(1);
		expect(
			s.dispositions.get({
				server: "main",
				threadId: "a",
				messageHash: "h-a",
				bankVersion: bankVersion(DEFAULT_BANK, c, "jev-1.15.0"),
			}),
		).toBeDefined();
		expect(bankVersion(DEFAULT_BANK, c, "jev-1.15.0")).not.toBe(bankVersion(DEFAULT_BANK, c, "jev-1.14.0"));
		// Mode and armedGraceMinutes only change how answers combine: no new call.
		await classifyIdle([thread("a")], cfg({ mode: "live", armedGraceMinutes: 10 }), d);
		expect(sent).toHaveLength(5);
	});

	test("a cached row is decided again from its answers as the thread ages past the armed-wait grace, with no call", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider(() => ({ ...no, promises_more_work: 0.9, claims_armed_wait: 0.9 }));
		const { d } = deps(s, provider);
		const c = cfg({ armedGraceMinutes: 360 });
		const young = thread("a", { idleMinutes: 60 });
		expect((await classifyIdle([young], c, d)).get(key(young))!.action).toBe("ignore");
		const old = thread("a", { idleMinutes: 400 });
		expect((await classifyIdle([old], c, d)).get(key(old))).toEqual({
			action: "nudge",
			reasons: [{ id: "promises_more_work", p: 0.9 }],
		});
		expect(sent).toHaveLength(1);
		const version = bankVersion(DEFAULT_BANK, c, "jev-1.14.0");
		expect(
			s.dispositions.get({ server: "main", threadId: "a", messageHash: "h-a", bankVersion: version }),
		).toMatchObject({ action: "nudge", reasons: ["promises_more_work"], idleMinutes: 400, classifiedAt: NOW });
	});

	test("a failure is unknown with its error recorded, never an action; it is retried on the next run", async () => {
		const s = memStore();
		let fail = true;
		const { provider, sent } = fakeProvider(() =>
			fail ? Error("Jev answered HTTP 503") : { ...no, work_finished: 0.9 },
		);
		const { d } = deps(s, provider);
		const c = cfg();
		const t = thread("a");
		expect((await classifyIdle([t], c, d)).get(key(t))).toEqual({
			action: "unknown",
			reasons: [],
			error: "Jev answered HTTP 503",
		});
		const k = {
			server: "main",
			threadId: "a",
			messageHash: "h-a",
			bankVersion: bankVersion(DEFAULT_BANK, c, "jev-1.14.0"),
		};
		expect(s.dispositions.get(k)).toMatchObject({ action: "unknown", error: "Jev answered HTTP 503", answers: {} });
		fail = false;
		expect((await classifyIdle([t], c, d)).get(key(t))!.action).toBe("settle");
		expect(s.dispositions.get(k)).toMatchObject({ action: "settle", error: null });
		expect(sent).toHaveLength(2);
	});

	test("a provider that cannot be built, or a bank that cannot be read, makes every thread unknown and never throws", async () => {
		const s = memStore();
		const { d, logs } = deps(s, fakeProvider().provider, {
			provider: () => {
				throw Error("no such provider");
			},
		});
		const out = await classifyIdle([thread("a"), thread("b")], cfg(), d);
		expect([...out.values()].map((v) => v.action)).toEqual(["unknown", "unknown"]);
		expect(logs.some((l) => l.event === "classifier-error")).toBe(true);
		const bad = await classifyIdle(
			[thread("a")],
			cfg({ questions: "missing.json" }),
			deps(s, fakeProvider().provider).d,
		);
		expect([...bad.values()][0]).toMatchObject({ action: "unknown" });
		expect([...bad.values()][0]!.error).toContain("cannot read missing.json");
	});

	test("budget.maxPerRun: the selection's first threads are classified, the rest stay unknown this run and are classified on a later one", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider();
		const { d, logs } = deps(s, provider);
		const c = cfg({ budget: { maxPerRun: 2, maxCallsPerDay: 500, maxUsdPerDay: 0.25 } });
		const ts = ["a", "b", "c", "d", "e"].map((id) => thread(id));
		const first = await classifyIdle(ts, c, d);
		expect(ts.map((t) => first.get(key(t))!.action)).toEqual(["escalate", "escalate", "unknown", "unknown", "unknown"]);
		expect(first.get(key(ts[2]!))!.error).toContain("maxPerRun");
		expect(sent).toHaveLength(2);
		// No row for a thread that was never tried.
		expect(s.dispositions.usage(0, ["jev"]).calls).toBe(2);
		expect(logs.at(-1)!.data).toMatchObject({ calls: 2, budget: expect.stringContaining("maxPerRun") });
		const second = await classifyIdle(ts, c, d);
		expect(ts.map((t) => second.get(key(t))!.action)).toEqual([
			"escalate",
			"escalate",
			"escalate",
			"escalate",
			"unknown",
		]);
		expect(sent).toHaveLength(4);
	});

	test("budget.maxCallsPerDay and maxUsdPerDay are summed from the table for the UTC day, and reset the next day", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider(undefined, { costUsd: 0.1 });
		const c = cfg({ budget: { maxPerRun: 20, maxCallsPerDay: 3, maxUsdPerDay: 1 } });
		const today = await classifyIdle(
			["a", "b", "c", "d"].map((id) => thread(id)),
			c,
			deps(s, provider).d,
		);
		expect([...today.values()].map((v) => v.action)).toEqual(["escalate", "escalate", "escalate", "unknown"]);
		expect([...today.values()][3]!.error).toContain("maxCallsPerDay spent until the next UTC day");
		// Later the same day: still spent.
		const { d: later, logs } = deps(s, provider, { now: NOW + 3600_000 });
		expect((await classifyIdle([thread("d")], c, later)).get("main:d:h-d")!.action).toBe("unknown");
		expect(logs.at(-1)!.data).toMatchObject({ dailyBudgetSpent: true });
		// The next UTC day: a fresh budget.
		const tomorrow = utcDayStart(NOW) + 24 * 3600_000 + 60_000;
		expect(
			(await classifyIdle([thread("d")], c, deps(s, provider, { now: tomorrow }).d)).get("main:d:h-d")!.action,
		).toBe("escalate");
		expect(sent).toHaveLength(4);
		// The dollar ceiling, summed from the table: a day that has spent it makes no call.
		const s2 = memStore();
		s2.dispositions.put({
			server: "main",
			threadId: "earlier",
			messageHash: "h",
			bankVersion: "v",
			classifiedAt: NOW - 60_000,
			provider: "haiku",
			model: "haiku",
			mode: "shadow",
			action: "settle",
			reasons: [],
			answers: {},
			idleMinutes: 60,
			sentChars: 10,
			redactions: 0,
			inputTokens: null,
			costUsd: 0.3,
			latencyMs: 9000,
			error: null,
		});
		const p2 = fakeProvider();
		const out = await classifyIdle(
			[thread("a")],
			cfg({ budget: { maxPerRun: 20, maxCallsPerDay: 500, maxUsdPerDay: 0.25 } }),
			deps(s2, p2.provider).d,
		);
		expect(out.get("main:a:h-a")!.error).toContain("maxUsdPerDay spent until the next UTC day");
		expect(p2.sent).toEqual([]);
	});

	test("the rules provider sends nothing, records sent_chars 0, and is not held to the daily budget", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider(() => ({ ...no, work_finished: 1 }), { name: "rules", model: "rules" });
		const c = cfg({
			provider: "rules",
			allowTextToLeaveMachine: false,
			budget: { maxPerRun: 20, maxCallsPerDay: 1, maxUsdPerDay: 0.25 },
		});
		const out = await classifyIdle(
			["a", "b"].map((id) => thread(id)),
			c,
			deps(s, provider).d,
		);
		expect([...out.values()].map((v) => v.action)).toEqual(["settle", "settle"]);
		expect(sent).toHaveLength(2);
		const row = s.dispositions.get({
			server: "main",
			threadId: "a",
			messageHash: "h-a",
			bankVersion: bankVersion(DEFAULT_BANK, c, "rules"),
		})!;
		expect(row).toMatchObject({ provider: "rules", sentChars: 0, redactions: 0 });
	});
});

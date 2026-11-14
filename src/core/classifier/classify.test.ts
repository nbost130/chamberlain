import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memStore } from "../../testing/store.ts";
import type { Store } from "../store.ts";
import { type Bank, DEFAULT_BANK } from "./bank.ts";
import { bankVersion, buildProvider, type ClassifyThread, classifyIdle } from "./classify.ts";
import { USAGE_KEY, utcDayStart } from "./classify-budget.ts";
import { CLASSIFIER_DEFAULTS, type ClassifierConfig } from "./config.ts";
import { type FetchLike, jevProvider, type Provider, ProviderError, type ProviderResult } from "./providers.ts";
import type { SentState } from "./state.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const IDS = DEFAULT_BANK.map((q) => q.id);
const no = Object.fromEntries(IDS.map((id) => [id, 0.02]));
/** A canary that must never reach the database. */
const CANARY = "CANARY-the-thread-text-7f3a";

const thread = (id: string, over: Partial<ClassifyThread> = {}): ClassifyThread => ({
	server: "main",
	threadId: id,
	lastMessageHash: `h-${id}`,
	idleMinutes: 120,
	title: `Thread ${id} ${CANARY}`,
	lastMessage: `${CANARY} say go and I'll start it.`,
	previous: { from: "human", text: `${CANARY} what now?` },
	...over,
});
const cfg = (over: Partial<ClassifierConfig> = {}): ClassifierConfig => ({
	...structuredClone(CLASSIFIER_DEFAULTS),
	provider: "jev",
	allowTextToLeaveMachine: true,
	...over,
});

/** A fake provider: answers per thread title, records each state it was sent, can be told to fail. */
function fakeProvider(
	answer: (s: SentState) => Record<string, number> | Error = () => ({ ...no, asks_decision: 0.98 }),
	o: { name?: Provider["name"]; model?: string; costUsd?: number } = {},
) {
	const sent: SentState[] = [];
	const provider: Provider = {
		name: o.name ?? "jev",
		model: o.model ?? "jev-1.14.0",
		classify: async (state, _bank: Bank): Promise<ProviderResult> => {
			sent.push(state);
			const a = answer(state);
			if (a instanceof Error) throw a;
			return { answers: a, model: "jev-1.14.0", inputTokens: 1717, costUsd: o.costUsd ?? 0.000072, latencyMs: 104 };
		},
	};
	return { provider, sent };
}
const deps = (store: Store, p: Provider, over: object = {}) => {
	const logs: { event: string; data?: Record<string, unknown> }[] = [];
	return {
		logs,
		d: {
			store,
			conf: mkdtempSync(join(tmpdir(), "conf-")),
			log: (event: string, data?: Record<string, unknown>) => logs.push({ event, ...(data ? { data } : {}) }),
			now: NOW,
			provider: () => p,
			...over,
		},
	};
};
const key = (t: ClassifyThread) => `${t.server}:${t.threadId}:${t.lastMessageHash}`;
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

	test("redaction runs before anything is sent; a failing hook sends nothing and the thread is unknown", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider();
		const email = ["ops", "@", "example.com"].join("");
		const t = thread("a", { lastMessage: `mail ${email} then say go` });
		const c = cfg();
		await classifyIdle([t], c, deps(s, provider).d);
		expect(sent[0]!.last_message).toBe("mail <email> then say go");
		const row = s.dispositions.get({
			server: "main",
			threadId: "a",
			messageHash: "h-a",
			bankVersion: bankVersion(DEFAULT_BANK, c, "jev-1.14.0"),
		})!;
		expect(row.redactions).toBe(1);
		// The hook's output is what goes.
		const hooked = cfg({ redact: { builtin: true, command: ["/bin/redact"] } });
		const { d } = deps(s, provider, {
			hook: async (_argv: string[], stdin: string) => ({
				code: 0,
				stdout: JSON.stringify({ ...JSON.parse(stdin), last_message: "[hooked]" }),
			}),
		});
		await classifyIdle([thread("b")], hooked, d);
		expect(sent[1]!.last_message).toBe("[hooked]");
		// A hook that fails: no call, unknown, sent_chars 0.
		const failing = deps(s, provider, { hook: async () => ({ code: 1, stdout: "" }) }).d;
		const out = await classifyIdle([thread("c")], hooked, failing);
		expect(out.get("main:c:h-c")).toEqual({ action: "unknown", reasons: [], error: "the redaction hook exited 1" });
		expect(sent).toHaveLength(2);
		const failed = s.dispositions.get({
			server: "main",
			threadId: "c",
			messageHash: "h-c",
			bankVersion: bankVersion(DEFAULT_BANK, hooked, "jev-1.14.0"),
		})!;
		expect(failed).toMatchObject({ action: "unknown", sentChars: 0 });
	});

	test("buildProvider: the config names the provider; the Jev key is read from the config directory's secrets at the call", async () => {
		const conf = mkdtempSync(join(tmpdir(), "conf-"));
		expect(buildProvider(cfg({ provider: "rules" }), conf).name).toBe("rules");
		expect(buildProvider(cfg({ provider: "haiku" }), conf)).toMatchObject({ name: "haiku", model: "haiku" });
		const jev = buildProvider(cfg(), conf);
		expect(jev).toMatchObject({ name: "jev", model: "jev-1.14.0" });
		// No key file: the call fails before any request, and says where the key belongs.
		await expect(
			jev.classify({ previous_message: { from: "none", text: "" }, last_message: "x" }, DEFAULT_BANK),
		).rejects.toThrow("no TypeSafe API key");
		expect(() => buildProvider(cfg({ provider: "none" }), conf)).toThrow("off");
		// The key file must be private: a world-readable one is refused, and the message never holds its contents.
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(join(conf, "secrets"), { recursive: true, mode: 0o700 });
		const secret = ["tsk", "live", "0123456789"].join("_");
		writeFileSync(join(conf, "secrets", "typesafe.key"), secret, { mode: 0o644 });
		chmodSync(join(conf, "secrets", "typesafe.key"), 0o644);
		const err = await buildProvider(cfg(), conf)
			.classify({ previous_message: { from: "none", text: "" }, last_message: "x" }, DEFAULT_BANK)
			.then(
				() => "",
				(e: Error) => e.message,
			);
		expect(err).toContain("mode exactly 0600");
		expect(err).not.toContain(secret);
	});

	test("never throws, even when the store does", async () => {
		const s = memStore();
		const broken = {
			...s,
			dispositions: {
				...s.dispositions,
				get: () => {
					throw Error("disk I/O error");
				},
			},
		} as Store;
		const out = await classifyIdle([thread("a")], cfg(), deps(broken, fakeProvider().provider).d);
		expect(out.get("main:a:h-a")).toMatchObject({ action: "unknown" });
	});
});

describe("the budget counts every attempt, not rows (review finding)", () => {
	test("a thread that keeps failing is retried each run, and each retry counts: maxCallsPerDay holds", async () => {
		const s = memStore();
		const { provider, sent } = fakeProvider(() => Error("Jev answered HTTP 503"));
		const c = cfg({ budget: { maxPerRun: 20, maxCallsPerDay: 2, maxUsdPerDay: 0.25 } });
		for (let run = 0; run < 6; run++)
			await classifyIdle([thread("a")], c, deps(s, provider, { now: NOW + run * 900_000 }).d);
		expect(sent).toHaveLength(2);
		// The table has one row (the latest attempt); the day's count has both.
		expect(s.dispositions.usage(0, ["jev"]).calls).toBe(1);
		expect(s.state.get(USAGE_KEY)).toEqual({ day: "2026-11-14", calls: 2, usd: 0 });
		const last = await classifyIdle([thread("a")], c, deps(s, provider).d);
		expect(last.get("main:a:h-a")!.error).toContain("maxCallsPerDay");
	});
	test("a failure then a success is two calls; the next UTC day starts the count again", async () => {
		const s = memStore();
		let fail = true;
		const { provider } = fakeProvider(() => (fail ? Error("Jev answered HTTP 503") : { ...no, work_finished: 0.9 }));
		const c = cfg();
		await classifyIdle([thread("a")], c, deps(s, provider).d);
		fail = false;
		await classifyIdle([thread("a")], c, deps(s, provider).d);
		expect(s.state.get(USAGE_KEY)).toMatchObject({ day: "2026-11-14", calls: 2 });
		await classifyIdle([thread("b")], c, deps(s, provider, { now: NOW + 86_400_000 }).d);
		expect(s.state.get(USAGE_KEY)).toMatchObject({ day: "2026-11-15", calls: 1 });
	});
	test("a call that was billed and then refused keeps its cost, in the row and in the dollar budget", async () => {
		const s = memStore();
		const billed: Provider = {
			name: "jev",
			model: "jev-1.14.0",
			classify: async () => {
				throw new ProviderError("the answer for asks_decision is missing or not a probability", {
					inputTokens: 5000,
					costUsd: 0.2,
				});
			},
		};
		const c = cfg({ budget: { maxPerRun: 20, maxCallsPerDay: 500, maxUsdPerDay: 0.25 } });
		await classifyIdle([thread("a")], c, deps(s, billed).d);
		const row = s.dispositions.get({
			server: "main",
			threadId: "a",
			messageHash: "h-a",
			bankVersion: bankVersion(DEFAULT_BANK, c, "jev-1.14.0"),
		})!;
		expect(row).toMatchObject({ action: "unknown", inputTokens: 5000, costUsd: 0.2 });
		await classifyIdle([thread("a")], c, deps(s, billed).d);
		expect(s.state.get(USAGE_KEY)).toMatchObject({ calls: 2, usd: 0.4 });
		// 0.4 spent of 0.25: the next thread makes no call.
		const p = fakeProvider();
		const out = await classifyIdle([thread("b")], c, deps(s, p.provider).d);
		expect(out.get("main:b:h-b")!.error).toContain("maxUsdPerDay");
		expect(p.sent).toEqual([]);
	});
	test("rules makes no count: nothing was sent and nothing was spent", async () => {
		const s = memStore();
		const { provider } = fakeProvider(() => ({ ...no, work_finished: 1 }), { name: "rules", model: "rules" });
		await classifyIdle([thread("a")], cfg({ provider: "rules", allowTextToLeaveMachine: false }), deps(s, provider).d);
		expect(s.state.get(USAGE_KEY)).toBeUndefined();
	});
});

describe("text a provider echoes back is never stored (review finding)", () => {
	test("a Jev reply whose model field is the message is refused, and the row holds no text", async () => {
		const s = memStore();
		const echo: FetchLike = async (_u, init) => {
			const body = JSON.parse(String(init.body));
			return new Response(
				JSON.stringify({
					model: body.state.last_message,
					answers: Object.fromEntries(IDS.map((id) => [id, { noul: 0.9 }])),
					usage: { input_tokens: 100 },
				}),
			);
		};
		const jev = jevProvider({ model: "jev-1.14.0", timeoutMs: 1000, key: () => "k", fetch: echo });
		const c = cfg();
		const out = await classifyIdle([thread("a")], c, deps(s, jev).d);
		expect(out.get("main:a:h-a")).toEqual({
			action: "unknown",
			reasons: [],
			error: "Jev reported a model id that is not one",
		});
		const row = s.dispositions.get({
			server: "main",
			threadId: "a",
			messageHash: "h-a",
			bankVersion: bankVersion(DEFAULT_BANK, c, "jev-1.14.0"),
		})!;
		expect(JSON.stringify(row)).not.toContain(CANARY);
		expect(row.costUsd).toBeCloseTo(100 * 0.042e-6, 12);
	});
});

describe("the disposition store (migration 13)", () => {
	const k = { server: "main", threadId: "a", messageHash: "h", bankVersion: "v1" };
	const row = {
		...k,
		classifiedAt: NOW,
		provider: "jev" as const,
		model: "jev-1.14.0",
		mode: "shadow" as const,
		action: "escalate" as const,
		reasons: ["asks_decision"],
		answers: { asks_decision: 0.98 },
		idleMinutes: 540,
		sentChars: 1900,
		redactions: 1,
		inputTokens: 1717,
		costUsd: 0.000072,
		latencyMs: 104,
		error: null,
	};
	test("put, get, and a replacement keeps feedback", () => {
		const s = memStore();
		s.dispositions.put(row);
		expect(s.dispositions.get(k)).toEqual({ ...row, feedback: null, correctedAction: null });
		expect(s.dispositions.feedback(k, "wrong", "settle")).toBe(true);
		s.dispositions.put({ ...row, classifiedAt: NOW + 1, action: "nudge" });
		expect(s.dispositions.get(k)).toMatchObject({
			action: "nudge",
			classifiedAt: NOW + 1,
			feedback: "wrong",
			correctedAction: "settle",
		});
		expect(s.dispositions.feedback({ ...k, threadId: "nope" }, "right")).toBe(false);
	});
	test("the table's checks: unknown exactly when an error is set; only known providers, modes, actions and feedback", () => {
		const s = memStore();
		expect(() => s.dispositions.put({ ...row, action: "unknown" })).toThrow();
		expect(() => s.dispositions.put({ ...row, error: "boom" })).toThrow();
		expect(() => s.dispositions.put({ ...row, provider: "gpt" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, mode: "loud" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, action: "panic" as never })).toThrow();
		expect(() => s.dispositions.put({ ...row, sentChars: -1 })).toThrow();
		s.dispositions.put(row);
		expect(() => s.dispositions.feedback(k, "maybe" as never)).toThrow();
		expect(() => s.dispositions.feedback(k, "wrong", "unknown" as never)).toThrow();
		s.dispositions.put({
			...row,
			threadId: "b",
			action: "unknown",
			error: "Jev answered HTTP 503",
			answers: {},
			reasons: [],
		});
	});
	test("redecide changes only the decision of a classified row, never an unknown one", () => {
		const s = memStore();
		s.dispositions.put(row);
		s.dispositions.redecide(k, { action: "ignore", reasons: ["claims_armed_wait"], idleMinutes: 600, mode: "live" });
		expect(s.dispositions.get(k)).toMatchObject({
			action: "ignore",
			reasons: ["claims_armed_wait"],
			idleMinutes: 600,
			mode: "live",
			classifiedAt: NOW,
		});
		const u = { ...k, threadId: "u" };
		s.dispositions.put({ ...row, ...u, action: "unknown", error: "x", reasons: [], answers: {} });
		s.dispositions.redecide(u, { action: "settle", reasons: [], idleMinutes: 1, mode: "live" });
		expect(s.dispositions.get(u)!.action).toBe("unknown");
	});
	test("usage counts the day's calls and spend per provider", () => {
		const s = memStore();
		s.dispositions.put(row);
		s.dispositions.put({ ...row, threadId: "b", costUsd: 0.5 });
		s.dispositions.put({ ...row, threadId: "c", provider: "haiku", costUsd: null });
		s.dispositions.put({ ...row, threadId: "old", classifiedAt: NOW - 86_400_000 });
		expect(s.dispositions.usage(NOW - 1000, ["jev"])).toEqual({ calls: 2, usd: 0.500072 });
		expect(s.dispositions.usage(NOW - 1000, ["jev", "haiku"]).calls).toBe(3);
		expect(s.dispositions.usage(NOW - 1000, [])).toEqual({ calls: 0, usd: 0 });
	});
	test("prune deletes old rows and keeps the ones with feedback (the next evaluation set)", () => {
		const s = memStore();
		s.dispositions.put({ ...row, threadId: "old", classifiedAt: NOW - 40 * 86_400_000 });
		s.dispositions.put({ ...row, threadId: "kept", classifiedAt: NOW - 40 * 86_400_000 });
		s.dispositions.feedback({ ...k, threadId: "kept" }, "right");
		s.dispositions.put(row);
		expect(s.dispositions.prune(NOW - 30 * 86_400_000)).toBe(1);
		expect(s.dispositions.get({ ...k, threadId: "old" })).toBeUndefined();
		expect(s.dispositions.get({ ...k, threadId: "kept" })).toBeDefined();
		expect(s.dispositions.get(k)).toBeDefined();
	});
	test("the table has no column that could hold message text", async () => {
		const { MIGRATIONS } = await import("../migrations.ts");
		const sql = MIGRATIONS.find((m) => m.version === 13)!.sql;
		const body = sql.slice(sql.indexOf("CREATE TABLE thread_dispositions ("), sql.indexOf("PRIMARY KEY"));
		const columns = [...body.matchAll(/^\t(\w+) (TEXT|INTEGER|REAL)/gm)].map((m) => m[1]);
		expect(columns).toEqual([
			"server",
			"thread_id",
			"message_hash",
			"bank_version",
			"classified_at",
			"provider",
			"model",
			"mode",
			"action",
			"reasons",
			"answers",
			"idle_minutes",
			"sent_chars",
			"redactions",
			"input_tokens",
			"cost_usd",
			"latency_ms",
			"error",
			"feedback",
			"corrected_action",
		]);
	});
});

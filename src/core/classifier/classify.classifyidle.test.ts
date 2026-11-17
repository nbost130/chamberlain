/** classify, continued: see classify.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CANARY,
	cfg,
	deps,
	fakeProvider,
	IDS,
	NOW,
	no,
	thread,
} from "../../testing/core-classifier-classify-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import type { Store } from "../store/store.ts";
import { DEFAULT_BANK } from "./bank.ts";
import { bankVersion, buildProvider, classifyIdle } from "./classify.ts";
import { USAGE_KEY } from "./classify-budget.ts";
import { type FetchLike, jevProvider, type Provider, ProviderError } from "./providers.ts";

describe("classifyIdle", () => {
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
		expect(() => buildProvider(cfg({ provider: "haiku" }), conf)).toThrow("config migrate");
		const jev = buildProvider(cfg({ jev: { model: "jev-1.14.0", keyFile: "typesafe.key", timeoutMs: 10000 } }), conf);
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
		const err = await jev
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

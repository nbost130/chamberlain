/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineExtraFixtures } from "../../testing/core-engine-extra-fixtures.ts";
import type { RunFailure } from "../adapter/adapter-inspect.ts";
import { DEFAULT_BANK } from "../classifier/bank.ts";
import type { Provider } from "../classifier/providers.ts";
import type { SentState } from "../classifier/state.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { flaky, rig, thread, idleRig, STREAM, m1, make } = useCoreEngineExtraFixtures(createEngine);

describe("an alert is never recorded as sent without its wake (a crash between the two loses nothing)", () => {
	describe("the idle-parents timer: its own schedule, apart from the routine sweep", () => {
		describe("with the classifier", () => {
			const IDS = DEFAULT_BANK.map((q) => q.id);
			const no = Object.fromEntries(IDS.map((id) => [id, 0.02]));
			/** A fake Jev: answers from the last message's words; counts calls; can be made to fail. */
			const fakeJev = (fail = false) => {
				const sent: SentState[] = [];
				const provider: Provider = {
					name: "jev",
					model: "jev-1.14.0",
					classify: async (state) => {
						sent.push(state);
						if (fail) throw Error("Jev answered HTTP 503");
						const m = state.last_message;
						const answers = /say go/i.test(m)
							? { ...no, asks_decision: 0.98 }
							: /I'll confirm/i.test(m)
								? { ...no, promises_more_work: 0.91 }
								: { ...no, work_finished: 0.96 };
						return { answers, model: "jev-1.14.0", inputTokens: 1700, costUsd: 0.00007, latencyMs: 100 };
					},
				};
				return { sent, make: () => provider };
			};
			const classifier = (mode: string) => ({
				idleParents: { classifier: { provider: "jev", allowTextToLeaveMachine: true, mode } },
			});
			const three = (
				seen: (id: string, s: string, o: object, l: { id: string; text: string; at: string }) => void,
				ago: (m: number, t: string, id?: string) => { id: string; text: string; at: string },
			) => {
				seen("ask", "idle", {}, ago(540, "The token is in. Say go and I'll start it."));
				seen("promise", "idle", {}, ago(400, "Opened the PR; I'll confirm when it merges."));
				seen("done", "completed", {}, ago(300, "Merged and deployed. Nothing more is owed."));
			};

			test("live: escalate and nudge are reported, tagged; the finished one only in the digest line; then the cache makes no call", async () => {
				const jev = fakeJev();
				const { r, ago, seen, pass } = idleRig(classifier("live"), jev.make);
				// Stay on one UTC day: pass(16)×3 near end-of-UTC-day would open a new settled-digest key.
				r.clock.t = Date.parse("2026-11-15T12:00:00Z");
				three(seen, ago);
				await r.quiet();
				await r.engine.tick();
				await r.until("the idle wake", () => r.fake.wakes.length === 1);
				const msg = r.fake.wakes[0]!.message;
				expect(msg).toContain("A classifier sorted them");
				// Two threads are reported; the digest line is not counted as one.
				expect(msg).toContain("[chamberlain] idle threads: 2 top-level threads finished");
				expect(msg).toContain(
					'[ESCALATE asks_decision 0.98] thread "Thread ask" on fake (threadId ask), idle 540 min.',
				);
				expect(msg).toContain(
					'[NUDGE promises_more_work 0.91] thread "Thread promise" on fake (threadId promise), idle 400 min.',
				);
				expect(msg).not.toContain("threadId done)");
				expect(msg).toContain(
					'1 idle thread looks finished (the classifier\'s settle; not reported one by one): "Thread done" on fake.',
				);
				expect(msg.indexOf("threadId ask")).toBeLessThan(msg.indexOf("threadId promise"));
				expect(jev.sent).toHaveLength(3);
				// What was sent: never a thread id or a server name.
				for (const s of jev.sent) expect(JSON.stringify(s)).not.toMatch(/"(ask|promise|done)"|fake/);
				// Many runs later, the same messages: no call and no wake.
				for (let n = 0; n < 3; n++) {
					pass(16);
					await r.engine.tick();
				}
				await r.quiet();
				expect(jev.sent).toHaveLength(3);
				expect(r.fake.wakes).toHaveLength(1);
				expect(r.events.filter((e) => e.event === "classifier").at(-1)).toMatchObject({ calls: 0, cached: 3 });
			});

			test("shadow: the wake is exactly as without the classifier, and the dispositions are recorded", async () => {
				const plain = idleRig();
				three(plain.seen, plain.ago);
				await plain.r.quiet();
				await plain.r.engine.tick();
				await plain.r.until("the plain wake", () => plain.r.fake.wakes.length === 1);
				const jev = fakeJev();
				const { r, ago, seen } = idleRig(classifier("shadow"), jev.make);
				three(seen, ago);
				await r.quiet();
				await r.engine.tick();
				await r.until("the shadow wake", () => r.fake.wakes.length === 1);
				const norm = (m: string) => m.replace(/idle-parents:\d+/g, "idle-parents:<at>");
				expect(norm(r.fake.wakes[0]!.message)).toBe(norm(plain.r.fake.wakes[0]!.message));
				expect(jev.sent).toHaveLength(3);
				expect(r.store.dispositions.usage(0, ["jev"]).calls).toBe(3);
			});

			test("live with Jev down: every thread is reported exactly as without the classifier", async () => {
				const plain = idleRig();
				three(plain.seen, plain.ago);
				await plain.r.quiet();
				await plain.r.engine.tick();
				await plain.r.until("the plain wake", () => plain.r.fake.wakes.length === 1);
				const jev = fakeJev(true);
				const { r, ago, seen } = idleRig(classifier("live"), jev.make);
				three(seen, ago);
				await r.quiet();
				await r.engine.tick();
				await r.until("the wake", () => r.fake.wakes.length === 1);
				const block = (m: string) => m.slice(m.indexOf("<<<"), m.indexOf(">>>"));
				expect(block(r.fake.wakes[0]!.message)).toBe(block(plain.r.fake.wakes[0]!.message));
				expect(r.events.some((e) => e.event === "idle-parents" && !("error" in e))).toBe(true);
			});

			test("off by default, and a sender without allowTextToLeaveMachine is refused: no call is ever made", async () => {
				for (const conf of [undefined, { idleParents: { classifier: { provider: "jev" } } }]) {
					const jev = fakeJev();
					const { r, ago, seen } = idleRig(conf, jev.make);
					three(seen, ago);
					await r.quiet();
					await r.engine.tick();
					await r.until("the wake", () => r.fake.wakes.length === 1);
					expect(r.fake.wakes[0]!.message).toContain("[ASKING]");
					expect(jev.sent).toEqual([]);
					expect(r.store.dispositions.usage(0, ["jev", "haiku", "rules"]).calls).toBe(0);
				}
			});
		});

		test("it can be switched off in the sweep section", async () => {
			const { r, seen, ago, runs } = idleRig({ idleParents: { enabled: false } });
			seen("a", "idle", {}, ago(180, "Say go."));
			await r.quiet();
			await r.engine.tick();
			await r.quiet();
			expect(r.fake.wakes).toEqual([]);
			expect(runs()).toBe(0);
			expect(r.store.items.list({ source: "check:idle-parents" })).toEqual([]);
		});
	});

	test("an approval held for the operator's return: the record that it was seen and the hold are one transaction", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap });
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		r.fake.threads.set("t1", {
			waiting: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }],
		});
		fail.at = "hold-item";
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		expect(r.engine.notified().has("req:fake:a1")).toBe(false);
		fail.at = undefined;
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		expect(
			heldOpen(r.store)
				.map((h) => h.what)
				.join("\n"),
		).toContain("command or permission approval: deploy");
		expect(r.engine.notified().has("req:fake:a1")).toBe(true);
	});
});

describe("stalled-thread recovery, end to end through the fake", () => {
	test("a stream failure is retried by the daemon after the grace, as the daemon, and the Steward is not woken", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		expect(x.fake.sends[0]).toMatchObject({ threadId: "t1", seed: "recover:t1:run-1", identity: "daemon" });
		expect(x.fake.sends[0]!.text).toMatch(/automatic retry/);
		await x.quiet();
		expect(x.fake.wakes).toEqual([]);
	});

	test("a retry that cannot be sent wakes the Steward as the failed wake, carrying why", async () => {
		const x = make();
		x.fake.send = async () => ({ ok: false, detail: "not sent: no operate token" });
		x.failRun("t1", "run-1", STREAM);
		await x.until("the failed wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain(
			"the automatic retry could not be sent (not sent: no operate token), so nothing has been retried",
		);
		expect(x.fake.wakes[0]!.deliveryId).toMatch(/^t1:failed:recover:\d+:\d+$/);
	});

	test("someone writing in the thread during the grace stands the retry down", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the failure is read", () => x.events.some((e) => e.event === "recover-scheduled"));
		x.fake.threads.set("t1", {
			...x.fake.threads.get("t1")!,
			instruction: {
				items: [m1, { type: "user_message", id: "m2", text: "restart", createdBy: "user", creationSource: "user" }],
				state: "complete",
				byMachine: false,
			},
		});
		await x.until("the stand-down", () => x.events.some((e) => e.event === "recover-stand-down"));
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
		expect(x.fake.wakes).toEqual([]);
	});

	test("what recovery must remember is written to the database's state table: the ping sent, so a restart sends no second first ping", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		await x.until(
			"the state written",
			() =>
				(x.store.state.get<{ threads: Record<string, { pings: number }> }>("recover")?.threads.t1?.pings ?? 0) === 1,
		);
		expect(x.store.state.get<{ handled: string[] }>("recover")!.handled).toContain("run-1");
	});

	test("a card that opens on the thread after the failure stops the retry at ping time", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("scheduled", () => x.events.some((e) => e.event === "recover-scheduled"));
		x.fake.threads.set("t1", {
			...x.fake.threads.get("t1")!,
			look: { latestRunId: "run-1", latestStatus: "failed", active: false, waiting: true },
		});
		await x.until("the stand-down", () => x.events.some((e) => e.event === "recover-stand-down"));
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
	});

	test("a second failure after the retry goes to the judge, and its verdict reaches the Steward as the failed wake", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		x.failRun("t1", "run-2", { ...STREAM, runId: "run-2" });
		await x.until("the verdict wake", () => x.fake.wakes.length === 1);
		const msg = x.fake.wakes[0]!.message;
		expect(msg).toContain("run failed twice (stream closed) after an automatic retry");
		expect(msg).toContain("small-model judge: do not retry — it keeps failing");
		expect(x.judgeCalls).toHaveLength(1);
		expect(x.asked).toEqual([]);
		expect(x.fake.sends).toHaveLength(1);
	});

	test("an ask_principal verdict also asks the principal through the decision queue", async () => {
		const x = make({ verdict: "ask_principal", reason: "a limit" });
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		x.failRun("t1", "run-2", { ...STREAM, runId: "run-2" });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.asked).toHaveLength(1);
		expect(x.asked[0]).toMatchObject({ kind: "only-you", threadId: "t1", server: "fake" });
		expect(x.fake.wakes[0]!.message).toContain("The principal has been asked on the decision queue.");
	});

	test("a judge that cannot answer still wakes the Steward, saying so", async () => {
		const x = make("fail");
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		x.failRun("t1", "run-2", { ...STREAM, runId: "run-2" });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain("the judge could not answer (small-model judge exited 1)");
	});

	test("two failures on different runs both fire a wake (the dedupe key names the run)", async () => {
		const x = make();
		const auth: RunFailure = {
			runId: "run-1",
			class: "provider_error",
			code: "api_error",
			message: "Claude could not authenticate.",
		};
		x.failRun("t1", "run-1", auth);
		await x.until("the first wake", () => x.fake.wakes.length === 1);
		x.failRun("t1", "run-2", { ...auth, runId: "run-2" });
		await x.until("the second wake", () => x.fake.wakes.length === 2);
		expect(new Set(x.fake.wakes.map((w) => w.deliveryId.split(":").slice(0, 4).join(":"))).size).toBe(2);
		expect(x.fake.sends).toEqual([]);
	});
});

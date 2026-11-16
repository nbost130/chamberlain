/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);

/** Posts that are not the rights-first prerequisite (slim turn_ended may send that ahead). */
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));

describe("a turn end waits for the Steward to be free", () => {
	const ended = (r: ReturnType<typeof rig>, id: string) => {
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: `s-${id}` }], state: "complete", byMachine: false },
			lastMessage: `${id} finished the work.`,
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
	};

	test("idle: the report goes at once, as one wake", async () => {
		const r = rig({ steward: "steward-1" });
		ended(r, "t2");
		await r.until("the report", () => posts(r).some((w) => w.message.includes('thread "Thread t2"')));
		const w = posts(r).find((x) => x.message.includes('thread "Thread t2"'))!;
		expect(w.message).toContain('thread "Thread t2" finished a turn on the work you sent it and has gone quiet.');
		expect(w.deliveryId).toContain("t2:ended:");
		expect(w.message).not.toContain("Last message");
		expect(r.held()).toEqual([]);
	});

	test("busy: the reports are held, and go as ONE digest when the fake reports idle", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t2");
		ended(r, "t3");
		await r.until("both held", () => r.held().length === 2);
		expect(r.fake.wakes).toEqual([]);
		// A heartbeat while it is still busy sends nothing.
		await r.engine.tick();
		expect(r.fake.wakes).toEqual([]);
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.until("the digest", () => posts(r).some((w) => w.deliveryId.startsWith("digest:")));
		const w = posts(r).find((x) => x.deliveryId.startsWith("digest:"))!;
		expect(w.deliveryId).toMatch(/^digest:[a-f0-9]{16}$/);
		expect(w.message).toContain("digest: 2 wakes were held while you were busy");
		expect(w.message).toContain('thread "Thread t2"');
		expect(w.message).toContain('thread "Thread t3"');
		expect(r.held()).toEqual([]);
		// Nothing more goes on a later heartbeat.
		await r.engine.tick();
		expect(posts(r).filter((x) => x.deliveryId.startsWith("digest:"))).toHaveLength(1);
	});

	test("unknown counts as busy: held, not posted", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("unknown");
		ended(r, "t2");
		await r.until("held", () => r.held().length === 1);
		await r.engine.tick();
		expect(r.fake.wakes).toEqual([]);
	});

	test("busy: a question or a failure still goes at once; only turn ends wait", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t2");
		r.fake.emit({ kind: "needs_input", thread: thread("t9", "waiting", { pendingRequestId: "q9" }) });
		await r.until("the question wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain('thread "Thread t9" is waiting');
		await r.until("the report held", () => r.held().length === 1);
		expect(r.fake.wakes).toHaveLength(1);
	});

	test("a thread the Steward did not instruct is not reported (the fake's history says so)", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.threads.set("t5", {
			instruction: {
				items: [{ type: "user_message", id: "u1", text: "fix it", createdBy: "user", creationSource: "web" }],
				state: "complete",
				byMachine: false,
			},
		});
		r.fake.emit({ kind: "state", thread: thread("t5", "running") });
		r.fake.emit({ kind: "state", thread: thread("t5", "completed") });
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
		expect(r.fake.wakes).toEqual([]);
	});

	describe("a thread the principal drove (the Steward never instructed it) still wakes the Steward on an ask, and only on an ask", () => {
		const principalDriven = (r: ReturnType<typeof rig>, id: string, lastMessage: string) => {
			r.fake.threads.set(id, {
				lastMessage,
				instruction: {
					items: [{ type: "user_message", id: "u1", text: "fix it", createdBy: "user", creationSource: "web" }],
					state: "complete",
					byMachine: false,
				},
			});
			r.fake.emit({ kind: "state", thread: thread(id, "running") });
			r.fake.emit({ kind: "state", thread: thread(id, "completed") });
		};
		// The real miss: the go-line was only in the spoken closing line.
		const SIGN_OFF =
			"The token is in place.\n\n🗣️ The breaker still needs its endpoint built; say go and I'll start it.";

		test("a go-phrase in the closing line wakes it as a handed-back question, not skipped", async () => {
			const r = rig({ steward: "steward-1" });
			principalDriven(r, "t5", SIGN_OFF);
			await r.until("the wake", () => posts(r).some((w) => w.message.includes("handed a question back")));
			expect(posts(r).at(-1)!.message).toContain("finished and handed a question back");
			expect(r.events.some((e) => e.event === "skip-turn-ended")).toBe(false);
		});
		test("a go-phrase that also says 'I'll start' is an ask, not a stall", async () => {
			const r = rig({ steward: "steward-1" });
			principalDriven(r, "t5", "The endpoint is not built yet. Say go and I'll start it.");
			await r.until("the wake", () => posts(r).some((w) => w.message.includes("handed a question back")));
			expect(posts(r).at(-1)!.message).toContain("finished and handed a question back");
			expect(posts(r).at(-1)!.message).not.toContain("stalled");
		});
		test("a plain finish on the same thread is still skipped", async () => {
			const r = rig({ steward: "steward-1" });
			principalDriven(r, "t5", "All done and verified.\n\n🗣️ Done.");
			await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
			expect(r.fake.wakes).toEqual([]);
		});
	});

	test("a wake the webhook refuses stays pending, its attempt counted, and goes on a later pass, once", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setWakeStatus(() => 503);
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("a failed attempt", () => r.fake.attempts >= 1);
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		expect(r.store.wakes.rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
		r.fake.setWakeStatus(() => 202);
		await r.engine.tick();
		expect(r.fake.wakes).toHaveLength(1);
		await r.engine.tick();
		expect(r.fake.wakes).toHaveLength(1);
		expect(r.store.wakes.rows()).toEqual([]);
	});
});

describe("an adapter with only the four required capabilities", () => {
	test("conforms, and a question still wakes with no excerpt and no question text (nothing to read)", async () => {
		const r = rig({ capabilities: [] });
		expect(r.fake.capabilities).toEqual([]);
		expect("inspect" in r.fake && r.fake.inspect).toBeFalsy();
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain('thread "Thread t1" is waiting for your answer or approval.');
		expect(r.fake.wakes[0]!.message).not.toContain("Last message");
		expect(r.fake.wakes[0]!.message).not.toContain("Question (untrusted");
	});

	test("a waiting status with no request id still wakes: with nothing to read, the status is the request", async () => {
		const r = rig({ capabilities: [] });
		r.fake.emit({ kind: "state", thread: thread("t1", "running") });
		r.fake.emit({ kind: "state", thread: thread("t1", "waiting") });
		await r.until("the wake", () => r.fake.wakes.length === 1);
	});

	test("every top-level turn end is its own report, since nothing says who instructed it", async () => {
		const r = rig({ capabilities: [], steward: "steward-1" });
		for (const n of [1, 2]) {
			r.clock.t += 60_000;
			r.fake.emit({ kind: "state", thread: thread("t2", "running") });
			r.fake.emit({ kind: "state", thread: thread("t2", "completed") });
			await r.until(`report ${n}`, () => posts(r).length === n);
		}
		expect(posts(r).map((w) => w.deliveryId.split(":")[1])).toEqual(["ended", "ended"]);
	});

	test("the heartbeat runs without a probe, a compaction target or a transcript, and records the connection", async () => {
		const r = rig({ capabilities: [], steward: "steward-1", housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		await r.engine.tick();
		const beat = r.store.state.get<{
			servers: { name: string; connected: boolean; version: string | null }[];
			log: Record<string, number>;
		}>("heartbeat")!;
		expect(beat.servers).toEqual([expect.objectContaining({ name: "fake", connected: true, version: "fake-1" })]);
		// The telemetry's own health rides the heartbeat: warn and error rows this process wrote, and the counters that must stay at zero.
		expect(beat.log).toEqual({ warn: 0, error: 0, rejected: 0, redacted: 0, failed: 0, dropped: 0 });
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
	});
});

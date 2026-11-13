/**
 * The engine against the in-memory fake adapter (src/testing/fake-adapter.ts): a second implementation of the contract.
 * Nothing here knows T3. Each test drives a fake thread event through the real rules, the real delivery and the real hold
 * store, on a scratch directory, and reads the wake the fake received.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFakeAdapter, type FakeAdapter } from "../testing/fake-adapter.ts";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { appendHeld, heldOpen } from "./afk.ts";
import { askQuestion, claimWake, pageClaim } from "./questions.ts";
import type { OptionalCapability, ThreadInput, WaitingItem } from "./adapter.ts";
import { createEngine, type EngineDeps } from "./engine.ts";
import type { HeldItem } from "./hold.ts";
import type { Store } from "./store.ts";
import type { TurnItem } from "./decide.ts";

const dirs: string[] = [];
const engines: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
	for (const e of engines.splice(0)) await e.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Logged = { event: string; [k: string]: unknown };
/** A scratch config and state directory, a fake backend, and an engine on them, fast enough to test (milliseconds, not minutes). */
function rig(o: { wrap?: (s: Store) => Store; adapter?: FakeAdapter; steward?: string; dry?: boolean; capabilities?: readonly OptionalCapability[]; compactAt?: number; housekeeping?: boolean; gh?: EngineDeps["gh"] } = {}) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-engine-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	const store = memStore();
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	const priv = (name: string, body: string) => writeFileSync(`${conf}/${name}`, body, { mode: 0o600 });
	priv("decision-rights.md", "The Steward may merge green PRs. Everything else, ask.");
	if (o.steward) priv("steward-thread", o.steward);
	const fake = o.adapter ?? createFakeAdapter({ capabilities: o.capabilities });
	/** The relay's clock: a post counts as "busy" for 30 seconds after it, so a test that sends two wakes moves it on. */
	const clock = { t: Date.now() };
	const events: Logged[] = [];
	const deps: EngineDeps = {
		conf, lock: testRelayLock(store), store: o.wrap ? o.wrap(store) : store, dry: o.dry, compactAt: o.compactAt, housekeeping: o.housekeeping ?? false, gh: o.gh,
		servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		log: (event, data) => events.push({ event, ...data }),
		timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
		relay: { retryAfterMs: () => 0, now: () => clock.t },
	};
	const engine = createEngine(deps);
	engines.push(engine);
	const running = engine.start();
	const until = async (what: string, ok: () => boolean, ms = 3000) => {
		const end = Date.now() + ms;
		while (!ok()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`); await Bun.sleep(5); }
	};
	const quiet = (ms = 80) => Bun.sleep(ms);
	const held = (): HeldItem[] => store.wakes.held();
	return { fake, engine, events, conf, store, priv, until, quiet, held, running, clock };
}

const thread = (id: string, status: string, over: Partial<ThreadInput> = {}): ThreadInput => ({ id, title: `Thread ${id}`, status, ...over });
const stewardSigned: TurnItem = { type: "user_message", id: "s1", text: "Steward: build it", createdBy: "agent", creationSource: "mcp" };
const question: WaitingItem = { type: "user_input_request", requestId: "req-1", label: "Pick", questions: [{ question: "Merge now?", options: [{ label: "Yes", description: "ship it" }, { label: "No" }] }] };

describe("a fake needs_input event wakes the Steward through the fake", () => {
	test("the wake names the thread, carries the question and the last message, and the rights, and is delivered once", async () => {
		const r = rig();
		r.fake.threads.set("t1", { lastMessage: "I cannot choose between the two.", waiting: [question] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1", title: "Build the thing" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		const w = r.fake.wakes[0]!;
		expect(w.deliveryId).toMatch(/^t1:needs_input:req-1:\d+$/);
		for (const x of [
			'[chamberlain] needs_input: thread "Build the thing" is waiting for your answer or approval.',
			"WAITING ON: a question with options. (Pick)",
			"server: fake (this server)",
			"threadId: t1  (top-level)",
			"Merge now?\n- Yes: ship it\n- No",
			"I cannot choose between the two.",
			"Decision rights (standing rules):",
			"The Steward may merge green PRs.",
		]) expect(w.message).toContain(x);
		// The same event again, and a restart-shaped repeat of it, wake nobody twice.
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.quiet();
		expect(r.fake.wakes).toHaveLength(1);
		// The relay delivered it: the row is delivered, and nothing is left pending or held.
		expect(r.store.wakes.rows()).toEqual([]);
		expect(r.held()).toEqual([]);
		expect(r.events.some((e) => e.event === "delivered" && e.http === 202)).toBe(true);
	});

	test("a thread's own state changes reach the same wake through the core's rules: a new request on a waiting thread", async () => {
		const r = rig();
		r.fake.threads.set("t1", { waiting: [question] });
		r.fake.emit({ kind: "state", thread: thread("t1", "running") });
		r.fake.emit({ kind: "state", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Merge now?");
		expect(r.fake.wakes[0]!.deliveryId).toContain("t1:input:req-1");
	});

	test("an approval says what is waiting and that only the operator can clear it; a failed run wakes at once", async () => {
		const r = rig();
		r.fake.threads.set("t1", { waiting: [{ type: "approval_request", requestId: "a1", label: "rm -rf build", questions: [] }] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the approval wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("WAITING ON: a command or permission APPROVAL.");
		expect(r.fake.wakes[0]!.message).toContain("(rm -rf build)");
		r.fake.emit({ kind: "state", thread: thread("t2", "running") });
		r.fake.emit({ kind: "state", thread: thread("t2", "failed") });
		await r.until("the failure wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).toContain('thread "Thread t2" run failed.');
	});

	test("while the operator is away, a command approval is held for their return and wakes nobody", async () => {
		const r = rig();
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		r.fake.threads.set("t1", { waiting: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		expect(heldOpen(r.store).map((h) => h.what).join("\n")).toContain("command or permission approval: deploy");
	});

	test("the Steward's own thread, an archived thread and an excluded thread never wake anyone", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.emit({ kind: "needs_input", thread: thread("steward-1", "waiting", { pendingRequestId: "x" }) });
		r.fake.emit({ kind: "needs_input", thread: thread("old", "waiting", { pendingRequestId: "y", archived: true }) });
		r.fake.emit({ kind: "state", thread: thread("steward-1", "running") });
		r.fake.emit({ kind: "state", thread: thread("steward-1", "failed") });
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
	});

	test("dry mode watches and logs, and posts nothing", async () => {
		const r = rig({ dry: true });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the dry log", () => r.events.some((e) => e.event === "dry"));
		expect(r.fake.attempts).toBe(0);
		expect(r.fake.wakes).toEqual([]);
	});
});

describe("a turn end waits for the Steward to be free", () => {
	const ended = (r: ReturnType<typeof rig>, id: string) => {
		r.fake.threads.set(id, { instruction: { items: [{ ...stewardSigned, id: `s-${id}` }], state: "complete", byMachine: false }, lastMessage: `${id} finished the work.` });
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
	};

	test("idle: the report goes at once, as one wake", async () => {
		const r = rig({ steward: "steward-1" });
		ended(r, "t2");
		await r.until("the report", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain('thread "Thread t2" finished a turn on the work you sent it and has gone quiet.');
		expect(r.fake.wakes[0]!.deliveryId).toContain("t2:ended:");
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
		expect(r.fake.wakes).toHaveLength(1);
		const w = r.fake.wakes[0]!;
		expect(w.deliveryId).toMatch(/^digest:[a-f0-9]{16}$/);
		expect(w.message).toContain("digest: 2 wakes were held while you were busy");
		expect(w.message).toContain('thread "Thread t2"');
		expect(w.message).toContain('thread "Thread t3"');
		expect(r.held()).toEqual([]);
		// Nothing more goes on a later heartbeat.
		await r.engine.tick();
		expect(r.fake.wakes).toHaveLength(1);
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
		r.fake.threads.set("t5", { instruction: { items: [{ type: "user_message", id: "u1", text: "fix it", createdBy: "user", creationSource: "web" }], state: "complete", byMachine: false } });
		r.fake.emit({ kind: "state", thread: thread("t5", "running") });
		r.fake.emit({ kind: "state", thread: thread("t5", "completed") });
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
		expect(r.fake.wakes).toEqual([]);
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
			await r.until(`report ${n}`, () => r.fake.wakes.length === n);
		}
		expect(r.fake.wakes.map((w) => w.deliveryId.split(":")[1])).toEqual(["ended", "ended"]);
	});

	test("the heartbeat runs without a probe, a compaction target or a transcript, and records the connection", async () => {
		const r = rig({ capabilities: [], steward: "steward-1", housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		await r.engine.tick();
		const beat = r.store.state.get<{ servers: { name: string; connected: boolean; version: string | null }[] }>("heartbeat")!;
		expect(beat.servers).toEqual([expect.objectContaining({ name: "fake", connected: true, version: "fake-1" })]);
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
	});
});

describe("the held ledger is reconciled on the heartbeat", () => {
	test("a tick closes the holds of an answered question, a merged PR and a settled thread, and leaves the rest", async () => {
		const gh = async (path: string) => (path.endsWith("/pulls/962") ? { state: "closed", merged_at: "2026-11-13T12:50:41Z" } : { state: "open" });
		const r = rig({ housekeeping: true, gh });
		await r.until("connected", () => r.fake.connected);
		const q = { id: "Q-tick1", kind: "only-you" as const, title: "t", context: "", options: [{ label: "Yes" }], thread: "T", server: "fake", createdAt: "2026-11-13T00:00:00.000Z" };
		askQuestion(r.store, q);
		const at = new Date("2026-11-13T01:00:00.000Z");
		appendHeld(r.store, { thread: "answered", what: "waits", item: "Q-tick1" }, at);
		appendHeld(r.store, { thread: "merged", what: "waits", ref: { pr: "o/r#962" } }, at);
		appendHeld(r.store, { thread: "open-pr", what: "waits", ref: { pr: "o/r#963" } }, at);
		appendHeld(r.store, { thread: "settled", what: "waits", ref: { threadId: "th-settled" } }, at);
		appendHeld(r.store, { thread: "prose", what: "merge o/r#962 for me" }, at);
		claimWake(r.store, pageClaim(q, { choice: 0, label: "Yes", by: "page", t: "2026-11-13T02:00:00.000Z", deliveryId: "answer:item:Q-tick1" }));
		r.fake.emit({ kind: "state", thread: thread("th-settled", "completed", { settled: true }) });
		await r.until("the thread is known", () => r.engine.watchers[0]!.states.has("th-settled"));
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread).sort()).toEqual(["open-pr", "prose"]);
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
		expect(r.events.some((e) => e.event === "held-reconciled")).toBe(true);
	});
});

describe("the engine's own dedupe is the item system's", () => {
	test("a wake that went out is a notification-log item, notified once, and an alarm is an item that notifies once per repeat interval", async () => {
		const r = rig();
		r.fake.threads.set("t1", { lastMessage: "Which one?", waiting: [question] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.store.items.get("notification-log", "req:req-1")).toMatchObject({ kind: "sent", status: "triggered", notificationCount: 1 });
		expect(r.engine.notified().has("req:req-1")).toBe(true);
		r.engine.alarm("steward-stalled", "stalled", "it is");
		r.engine.alarm("steward-stalled", "stalled", "it is");
		expect(r.events.filter((e) => e.event === "alarm")).toHaveLength(1);
		expect(r.store.items.get("alarm", "steward-stalled")).toMatchObject({ kind: "alarm", status: "triggered", notificationCount: 1 });
		expect(r.store.items.get("alarm", "steward-stalled")!.nextNotificationAt).toBeGreaterThan(Date.now());
	});
});

describe("the Steward's own upkeep goes through the probe and the compaction transport", () => {
	test("past the size limit a compaction is sent once, with the rights re-sent after it", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000 });
		r.fake.probe = { readable: true, contextTokens: 5000 };
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
		expect(r.fake.compactions[0]).toMatch(/^compact:steward-1:\d+$/);
		// The cooldown keeps the next heartbeat from sending another.
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
	});

	test("a compaction the probe says must not go is not sent, and a stalled Steward raises its alarm", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000 });
		r.fake.probe = { readable: true, contextTokens: 5000, compactBlocked: "one is already queued or running", stalled: { title: "The Steward has stopped taking wakes", summary: "2 wakes queued" } };
		await r.engine.tick();
		expect(r.fake.compactions).toEqual([]);
		expect(r.events.find((e) => e.event === "skip-compact")).toMatchObject({ reason: "one is already queued or running" });
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-stalled")).toBeDefined();
	});

	test("with no compaction capability the size limit only raises an alarm", async () => {
		const r = rig({ steward: "steward-1", compactAt: 1000, capabilities: ["stewardProbe"] });
		r.fake.probe = { readable: true, contextTokens: 5000 };
		await r.engine.tick();
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-compact")).toBeDefined();
	});

	test("a probe that can't read the Steward five times running raises the blind alarm", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: false };
		for (let n = 0; n < 5; n++) await r.engine.tick();
		expect(r.events.find((e) => e.event === "alarm" && e.key === "steward-queue-unreadable")).toBeDefined();
	});
});

// ---- B1: a notification decision and its wake are one transaction -----------------------------------

/**
 * A store whose writes can be made to fail where a crash would land: after the decision has been written and before the wake's
 * outbox (or held) row is. `fail.at` names the write that throws; every write is delegated otherwise.
 */
function flaky() {
	const fail = { at: undefined as undefined | "enqueue" | "held-push" | "hold-item" };
	const wrap = (s: Store): Store => ({
		...s,
		wakes: {
			...s.wakes,
			enqueue: (...a: Parameters<Store["wakes"]["enqueue"]>) => { if (fail.at === "enqueue") throw Error("the disk went away"); return s.wakes.enqueue(...a); },
			hold: (...a: Parameters<Store["wakes"]["hold"]>) => { if (fail.at === "held-push") throw Error("the disk went away"); return s.wakes.hold(...a); },
		},
		items: { ...s.items, observe: (o) => { if (fail.at === "hold-item" && o.source === "held") throw Error("the disk went away"); return s.items.observe(o); } },
	});
	return { fail, wrap };
}

describe("an alert is never recorded as sent without its wake (a crash between the two loses nothing)", () => {
	test("a daemon wake: when the outbox row cannot be written, the notification is not recorded either, and the same event wakes the Steward once the disk is back", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap });
		r.fake.threads.set("t1", { lastMessage: "stuck", waiting: [question] });
		fail.at = "enqueue";
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		// Nothing of the decision survives: no notification-log item for the request or the event, and no wake queued.
		expect(r.engine.notified().size).toBe(0);
		expect(r.store.wakes.rows()).toEqual([]);
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Merge now?");
		expect([...r.engine.notified()].sort()).toEqual(expect.arrayContaining(["req:req-1"]));
		expect(r.store.wakes.rows()).toEqual([]);
	});

	test("a held turn end: the same, through the held store", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, steward: "steward-1" });
		const ended = () => {
			r.fake.threads.set("t9", { instruction: { items: [{ ...stewardSigned, id: "s-t9" }], state: "complete", byMachine: false }, lastMessage: "t9 finished the work." });
			r.fake.emit({ kind: "state", thread: thread("t9", "running") });
			r.fake.emit({ kind: "state", thread: thread("t9", "completed") });
		};
		fail.at = "held-push";
		ended();
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		// Neither the report's record nor the turn's own key was written: the next turn end is still news.
		expect(r.engine.notified().size).toBe(0);
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		ended();
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain('thread "Thread t9" finished a turn on the work you sent it and has gone quiet.');
	});

	test("a sweep finding: when the wake cannot be queued, the finding is not recorded as notified and the clock does not move, so the next sweep wakes with it", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, housekeeping: true });
		r.priv("sweep.json", JSON.stringify({ checks: [{ name: "disk", command: ["/bin/echo", JSON.stringify([{ dedupKey: "root", text: "the root disk is 97% full" }])] }] }));
		fail.at = "held-push";
		await r.engine.tick();
		expect(r.events.some((e) => e.event === "sweep-error")).toBe(true);
		expect(r.store.items.get("check:disk", "root")).toBeUndefined();
		expect(r.store.state.get("sweep-clock")).toMatchObject({ seeded: false });
		expect(r.fake.wakes).toEqual([]);
		fail.at = undefined;
		await r.engine.tick();
		await r.until("the sweep wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("the root disk is 97% full");
		expect(r.store.items.get("check:disk", "root")).toMatchObject({ status: "triggered", notificationCount: 1 });
		expect(r.store.state.get("sweep-clock")).toMatchObject({ seeded: true });
		// And it stays quiet afterwards: one notification, one wake.
		await r.engine.tick();
		await r.quiet();
		expect(r.fake.wakes).toHaveLength(1);
	});

	test("an approval held for the operator's return: the record that it was seen and the hold are one transaction", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap });
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		r.fake.threads.set("t1", { waiting: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }] });
		fail.at = "hold-item";
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the failed commit", () => r.events.some((e) => e.event === "fire-error"));
		expect(r.engine.notified().has("req:a1")).toBe(false);
		fail.at = undefined;
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		expect(heldOpen(r.store).map((h) => h.what).join("\n")).toContain("command or permission approval: deploy");
		expect(r.engine.notified().has("req:a1")).toBe(true);
	});
});

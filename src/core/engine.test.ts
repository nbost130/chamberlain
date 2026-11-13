/**
 * The engine against the in-memory fake adapter (src/testing/fake-adapter.ts): a second implementation of the contract.
 * Nothing here knows T3. Each test drives a fake thread event through the real rules, the real delivery and the real hold
 * store, on a scratch directory, and reads the wake the fake received.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFakeAdapter, type FakeAdapter } from "../testing/fake-adapter.ts";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { appendHeld, heldOpen } from "./afk.ts";
import { askQuestion, claimWake, pageClaim } from "./questions.ts";
import type { OptionalCapability, RunFailure, ThreadInput, WaitingItem } from "./adapter.ts";
import type { Judge } from "./judge.ts";
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

	// Fix 1. Must fail on 2845f33: the watcher's cache said settled and the hold closed while the server could not be reached.
	test("fix 1: with the server unreachable, a thread the watcher's cache calls settled closes nothing", async () => {
		const r = rig({ housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		appendHeld(r.store, { thread: "cached-settled", what: "waits", ref: { threadId: "th-settled" } }, new Date("2026-11-13T01:00:00.000Z"));
		r.fake.emit({ kind: "state", thread: thread("th-settled", "completed", { settled: true }) });
		await r.until("the cache has it", () => r.engine.watchers[0]!.states.get("th-settled")?.settled === true);
		r.fake.snapshotError = "connect ECONNREFUSED";
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread)).toEqual(["cached-settled"]);
		r.fake.snapshotError = undefined;
		r.fake.snapshotComplete = false;
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread)).toEqual(["cached-settled"]);
	});

	test("fix 1: a thread its named server no longer lists is gone, and the hold closes from a fresh snapshot; one naming no server stays", async () => {
		const r = rig({ housekeeping: true, capabilities: ["snapshot"] });
		await r.until("connected", () => r.fake.connected);
		appendHeld(r.store, { thread: "deleted", what: "waits", server: "fake", ref: { threadId: "th-deleted" } }, new Date("2026-11-13T01:00:00.000Z"));
		appendHeld(r.store, { thread: "listed", what: "waits", server: "fake", ref: { threadId: "th-listed" } }, new Date("2026-11-13T01:00:00.000Z"));
		appendHeld(r.store, { thread: "unnamed", what: "waits", ref: { threadId: "th-deleted" } }, new Date("2026-11-13T01:00:00.000Z"));
		r.fake.emit({ kind: "state", thread: thread("th-listed", "running") });
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.thread).sort()).toEqual(["listed", "unnamed"]);
	});

	test("fix 1: an adapter that cannot take a snapshot leaves its threads unknown", async () => {
		const r = rig({ housekeeping: true, capabilities: [] });
		await r.until("connected", () => r.fake.connected);
		appendHeld(r.store, { thread: "h", what: "waits", ref: { threadId: "th-gone" } }, new Date("2026-11-13T01:00:00.000Z"));
		await r.engine.tick();
		expect(heldOpen(r.store)).toHaveLength(1);
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

describe("stalled-thread recovery, end to end through the fake", () => {
	const STREAM: RunFailure = { runId: "run-1", class: "unknown", message: "The provider event stream closed unexpectedly. Retry the turn." };
	const FAST = { graceMs: 40, rateLimitWaitMs: 80, secondFailureWindowMs: 5_000, breakerWindowMs: 5_000, breakerQuietMs: 5_000 };
	const m1: TurnItem = { type: "user_message", id: "m1", text: "do the thing", createdBy: "user", creationSource: "user" };
	/** A rig whose engine has recovery on, with fast timing and a judge that answers from the test. */
	function make(judged: { verdict: string; reason: string } | "fail" = { verdict: "do_not_retry", reason: "it keeps failing" }) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-recover-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "rights", { mode: 0o600 });
		const store = memStore();
		const fake = createFakeAdapter();
		const events: Logged[] = [];
		const asked: Record<string, any>[] = [];
		const judgeCalls: unknown[] = [];
		const clock = { t: Date.now() };
		const engine = createEngine({
			conf, lock: testRelayLock(store), store, housekeeping: false,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => clock.t },
			recover: FAST,
			ask: async (raw) => { asked.push(raw as Record<string, any>); },
			judge: async (trigger, brief) => { judgeCalls.push({ trigger, brief }); return judged === "fail" ? { ok: false, backend: "haiku", error: "haiku judge exited 1" } : { ok: true, backend: "haiku", ...judged }; },
		});
		engines.push(engine);
		void engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`); await Bun.sleep(5); } };
		const failRun = (id: string, runId: string, failure: RunFailure, over: Partial<ThreadInput> = {}) => {
			fake.threads.set(id, { ...(fake.threads.get(id) ?? {}), failure, instruction: { items: [m1], state: "complete", byMachine: false } });
			fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: runId, ...over }) });
			fake.emit({ kind: "state", thread: thread(id, "failed", { latestRunId: runId, ...over }) });
		};
		return { fake, events, asked, judgeCalls, until, failRun, store, quiet: (ms = 120) => Bun.sleep(ms) };
	}

	test("a stream failure is retried by the daemon after the grace, as the daemon, and the Steward is not woken", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		expect(x.fake.sends[0]).toMatchObject({ threadId: "t1", seed: "recover:t1:run-1", identity: "daemon" });
		expect(x.fake.sends[0]!.text).toMatch(/automatic retry/);
		await x.quiet();
		expect(x.fake.wakes).toEqual([]);
	});

	test("someone writing in the thread during the grace stands the retry down", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the failure is read", () => x.events.some((e) => e.event === "recover-scheduled"));
		x.fake.threads.set("t1", { ...x.fake.threads.get("t1")!, instruction: { items: [m1, { type: "user_message", id: "m2", text: "restart", createdBy: "user", creationSource: "user" }], state: "complete", byMachine: false } });
		await x.until("the stand-down", () => x.events.some((e) => e.event === "recover-stand-down"));
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
		expect(x.fake.wakes).toEqual([]);
	});

	test("what recovery must remember is written to the database's state table: the ping sent, so a restart sends no second first ping", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("the retry", () => x.fake.sends.length === 1);
		await x.until("the state written", () => (x.store.state.get<{ threads: Record<string, { pings: number }> }>("recover")?.threads.t1?.pings ?? 0) === 1);
		expect(x.store.state.get<{ handled: string[] }>("recover")!.handled).toContain("run-1");
	});

	test("a card that opens on the thread after the failure stops the retry at ping time", async () => {
		const x = make();
		x.failRun("t1", "run-1", STREAM);
		await x.until("scheduled", () => x.events.some((e) => e.event === "recover-scheduled"));
		x.fake.threads.set("t1", { ...x.fake.threads.get("t1")!, look: { latestRunId: "run-1", latestStatus: "failed", active: false, waiting: true } });
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
		expect(msg).toContain("haiku judge: do not retry — it keeps failing");
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
		expect(x.fake.wakes[0]!.message).toContain("the judge could not answer (haiku judge exited 1)");
	});

	test("two failures on different runs both fire a wake (the dedupe key names the run)", async () => {
		const x = make();
		const auth: RunFailure = { runId: "run-1", class: "provider_error", code: "api_error", message: "Claude could not authenticate." };
		x.failRun("t1", "run-1", auth);
		await x.until("the first wake", () => x.fake.wakes.length === 1);
		x.failRun("t1", "run-2", { ...auth, runId: "run-2" });
		await x.until("the second wake", () => x.fake.wakes.length === 2);
		expect(new Set(x.fake.wakes.map((w) => w.deliveryId.split(":").slice(0, 4).join(":"))).size).toBe(2);
		expect(x.fake.sends).toEqual([]);
	});

	test("a never-retry failure wakes the Steward at once, naming why, and sends nothing", async () => {
		const x = make();
		x.failRun("t1", "run-1", { runId: "run-1", class: "provider_error", code: "api_error_403", message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain("not retried automatically: a 403 / Cloudflare block");
		await x.quiet();
		expect(x.fake.sends).toEqual([]);
	});

	test("a waiting thread, and the Steward's own thread, are never retried", async () => {
		const x = make();
		x.failRun("w", "run-1", STREAM, { backgroundTasks: 1 });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain("not retried automatically: waiting: a watch, gate or background task is parked");
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
	});

	test("three failures of one kind raise exactly one alarm through the decision queue, and stop every retry", async () => {
		const x = make();
		for (const [i, id] of ["a", "b", "c"].entries()) x.failRun(id, `run-${i + 1}`, { ...STREAM, runId: `run-${i + 1}` });
		await x.until("the alarm", () => x.asked.length === 1);
		x.failRun("d", "run-4", { ...STREAM, runId: "run-4" });
		await x.quiet(250);
		expect(x.asked).toHaveLength(1);
		expect(x.asked[0]).toMatchObject({ kind: "only-you", tag: "Outage" });
		expect(x.asked[0]!.title).toContain("3");
		expect(x.fake.sends).toEqual([]);
		expect(x.fake.wakes).toEqual([]);
	});

	test("an adapter that cannot read a failure keeps the plain failed wake, with no retry", async () => {
		const r = rig({ capabilities: ["send"] });
		r.fake.emit({ kind: "state", thread: thread("t1", "running") });
		r.fake.emit({ kind: "state", thread: thread("t1", "failed", { latestRunId: "run-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain('run failed.');
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		expect(r.fake.sends).toEqual([]);
	});
});

describe("fix round 1: recovery is OFF unless asked for, and the production launcher asks only with CHAMBERLAIN_RECOVER=1", () => {
	test("an engine built without `recover` keeps the plain failed wake and retries nothing", async () => {
		const r = rig();
		r.fake.threads.set("t1", { failure: { runId: "run-1", class: "unknown", message: "The provider event stream closed unexpectedly." } });
		r.fake.emit({ kind: "state", thread: thread("t1", "running", { latestRunId: "run-1" }) });
		r.fake.emit({ kind: "state", thread: thread("t1", "failed", { latestRunId: "run-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("run failed.");
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		await r.quiet(150);
		expect(r.fake.sends).toEqual([]);
		expect(r.store.state.get("recover")).toBeUndefined();
	});
	test("the daemon launcher turns it on only for CHAMBERLAIN_RECOVER=1", () => {
		const src = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
		expect(src).toContain('recover: process.env.CHAMBERLAIN_RECOVER === "1"');
	});
});

describe("the judge is an explicit setting", () => {
	const make = (o: { recover: boolean; judgeJson?: string }) => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-judge-off-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		if (o.judgeJson) writeFileSync(`${conf}/judge.json`, o.judgeJson, { mode: 0o600 });
		const store = memStore();
		const events: Logged[] = [];
		const engine = createEngine({ conf, lock: testRelayLock(store), store, housekeeping: false, servers: [{ server: { name: "fake", adapter: "fake" }, adapter: createFakeAdapter() }], log: (event, data) => events.push({ event, ...data }), ...(o.recover ? { recover: true } : {}) });
		engines.push(engine);
		return events;
	};
	test("recovery on and no judge.json: judging is off, and the log says why", () => {
		const events = make({ recover: true });
		const off = events.filter((e) => e.event === "judge-off");
		expect(off).toHaveLength(1);
		expect(off[0]).toMatchObject({ trigger: "stalled-recovery" });
		expect(String(off[0]!.why)).toContain("names no backend");
	});
	test("a judge.json that names a backend turns judging on: no judge-off line", () => {
		const events = make({ recover: true, judgeJson: JSON.stringify({ triggers: { "stalled-recovery": { backend: "small" } }, backends: { small: { command: ["/bin/false"] } } }) });
		expect(events.filter((e) => e.event === "judge-off")).toEqual([]);
	});
	test("recovery off: nothing needs a judge, so nothing is said", () => {
		expect(make({ recover: false }).filter((e) => e.event === "judge-off")).toEqual([]);
	});
});

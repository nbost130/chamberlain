/**
 * The engine against the in-memory fake adapter (src/testing/fake-adapter.ts): a second implementation of the contract.
 * Nothing here knows T3. Each test drives a fake thread event through the real rules, the real delivery and the real hold
 * store, on a scratch directory, and reads the wake the fake received.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createFakeAdapter, type FakeAdapter } from "../testing/fake-adapter.ts";
import { noAlert } from "../testing/alert.ts";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore } from "./sqlite-store.ts";
import { appendHeld, heldOpen } from "./afk.ts";
import { closeCardByHand } from "./card-hold.ts";
import { askQuestion, claimWake, getQuestion, pageClaim, questionStates } from "./questions.ts";
import type { OptionalCapability, RunFailure, ThreadInput, WaitingItem } from "./adapter.ts";
import type { Judge } from "./judge.ts";
import { withDeliveryId } from "./deliver.ts";
import { DEFAULT_BANK } from "./classifier/bank.ts";
import type { Provider } from "./classifier/providers.ts";
import type { SentState } from "./classifier/state.ts";
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
function rig(
	o: {
		store?: Store;
		wrap?: (s: Store) => Store;
		adapter?: FakeAdapter;
		steward?: string;
		dry?: boolean;
		capabilities?: readonly OptionalCapability[];
		compactAt?: number;
		housekeeping?: boolean;
		gh?: EngineDeps["gh"];
		ask?: EngineDeps["ask"];
		classifierProvider?: EngineDeps["classifierProvider"];
	} = {},
) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-engine-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	const store = o.store ?? memStore();
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	const priv = (name: string, body: string) => writeFileSync(`${conf}/${name}`, body, { mode: 0o600 });
	priv("decision-rights.md", "The Steward may merge green PRs. Everything else, ask.");
	if (o.steward) priv("steward-thread", o.steward);
	const fake = o.adapter ?? createFakeAdapter({ capabilities: o.capabilities });
	/** The relay's clock: a post counts as "busy" for 30 seconds after it, so a test that sends two wakes moves it on. */
	const clock = { t: Date.now() };
	const events: Logged[] = [];
	const deps: EngineDeps = {
		conf,
		lock: testRelayLock(store),
		alert: noAlert,
		store: o.wrap ? o.wrap(store) : store,
		dry: o.dry,
		compactAt: o.compactAt,
		housekeeping: o.housekeeping ?? false,
		gh: o.gh,
		ask: o.ask,
		...(o.classifierProvider ? { classifierProvider: o.classifierProvider } : {}),
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
		while (!ok()) {
			if (Date.now() > end) throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
			await Bun.sleep(5);
		}
	};
	const quiet = (ms = 80) => Bun.sleep(ms);
	const held = (): HeldItem[] => store.wakes.held();
	return { fake, engine, events, conf, store, priv, until, quiet, held, running, clock };
}

const thread = (id: string, status: string, over: Partial<ThreadInput> = {}): ThreadInput => ({
	id,
	title: `Thread ${id}`,
	status,
	...over,
});
const stewardSigned: TurnItem = {
	type: "user_message",
	id: "s1",
	text: "Steward: build it",
	createdBy: "agent",
	creationSource: "mcp",
};
const question: WaitingItem = {
	type: "user_input_request",
	requestId: "req-1",
	label: "Pick",
	questions: [{ question: "Merge now?", options: [{ label: "Yes", description: "ship it" }, { label: "No" }] }],
};

describe("a fake needs_input event wakes the Steward through the fake", () => {
	test("the wake names the thread, carries the question and the last message, and the rights, and is delivered once", async () => {
		const r = rig();
		r.fake.threads.set("t1", { lastMessage: "I cannot choose between the two.", waiting: [question] });
		r.fake.emit({
			kind: "needs_input",
			thread: thread("t1", "waiting", { pendingRequestId: "req-1", title: "Build the thing" }),
		});
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
		])
			expect(w.message).toContain(x);
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
		r.fake.threads.set("t1", {
			waiting: [{ type: "approval_request", requestId: "a1", label: "rm -rf build", questions: [] }],
		});
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
		r.fake.threads.set("t1", {
			waiting: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }],
		});
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		expect(
			heldOpen(r.store)
				.map((h) => h.what)
				.join("\n"),
		).toContain("command or permission approval: deploy");
	});

	test("(d) while away, a card is held behind a pointer question that is posted once and closes when the card leaves", async () => {
		const r = rig();
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		r.fake.threads.set("t1", {
			waiting: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }],
		});
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1", title: "Release" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		const qs = [...questionStates(r.store).values()];
		expect(qs.map((q) => [q.cardRequest, q.server, q.status])).toEqual([["a1", "fake", "open"]]);
		expect(heldOpen(r.store).map((h) => h.item)).toEqual([qs[0]!.id]);
		await r.until("the post", () => r.fake.posted.length === 1);
		expect(r.fake.posted[0]!.item.id).toBe(qs[0]!.id);
		// Seen again: nothing new is filed, held or posted.
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1", title: "Release" }) });
		await r.quiet();
		expect(questionStates(r.store).size).toBe(1);
		expect(heldOpen(r.store)).toHaveLength(1);
		expect(r.fake.posted).toHaveLength(1);
		// Answered on the card: the card's own item shows it resolved, and the question and the hold close with it (after a read of the thread's cards).
		r.fake.threads.set("t1", { waiting: [], resolved: ["a1"] });
		r.fake.emit({ kind: "state", thread: thread("t1", "running", { title: "Release" }) });
		await r.until("the card reconciled", () => r.events.some((e) => e.event === "card-reconciled"));
		expect(getQuestion(r.store, qs[0]!.id)!.status).toBe("answered-on-card");
		expect(heldOpen(r.store)).toEqual([]);
		expect(r.fake.wakes).toEqual([]);
	});

	test("(d) a secret card held while away copies nothing of the card's content anywhere, and its question is never posted", async () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-secret-`);
		dirs.push(root);
		const store = openStore(`${root}/chamberlain.db`);
		const r = rig({ store });
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const SENTINEL = "plain-SENTINEL-not-a-key";
		r.fake.threads.set("t1", {
			lastMessage: "need the key",
			waiting: [
				{
					type: "secret_request",
					requestId: "s1",
					label: "STRIPE_KEY",
					questions: [{ question: `value: ${SENTINEL}`, options: [{ label: SENTINEL, description: SENTINEL }] }],
				},
			],
		});
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "s1" }) });
		await r.until("the hold", () => r.events.some((e) => e.event === "held-by-daemon"));
		await r.quiet();
		const qs = [...questionStates(store).values()];
		expect(qs.map((q) => [q.secret, q.cardRequest])).toEqual([[true, "s1"]]);
		expect(r.fake.posted).toEqual([]);
		expect(r.fake.wakes).toEqual([]);
		expect(JSON.stringify(r.events)).not.toContain("SENTINEL");
		await r.engine.stop();
		engines.splice(engines.indexOf(r.engine), 1);
		store.close();
		for (const f of readdirSync(root))
			expect(readFileSync(`${root}/${f}`).includes(Buffer.from("SENTINEL"))).toBe(false);
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
		await r.until("the report", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain(
			'thread "Thread t2" finished a turn on the work you sent it and has gone quiet.',
		);
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
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("finished and handed a question back");
			expect(r.events.some((e) => e.event === "skip-turn-ended")).toBe(false);
		});
		test("a go-phrase that also says 'I'll start' is an ask, not a stall", async () => {
			const r = rig({ steward: "steward-1" });
			principalDriven(r, "t5", "The endpoint is not built yet. Say go and I'll start it.");
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("finished and handed a question back");
			expect(r.fake.wakes[0]!.message).not.toContain("stalled");
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
			await r.until(`report ${n}`, () => r.fake.wakes.length === n);
		}
		expect(r.fake.wakes.map((w) => w.deliveryId.split(":")[1])).toEqual(["ended", "ended"]);
	});

	test("the heartbeat runs without a probe, a compaction target or a transcript, and records the connection", async () => {
		const r = rig({ capabilities: [], steward: "steward-1", housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		await r.engine.tick();
		const beat = r.store.state.get<{ servers: { name: string; connected: boolean; version: string | null }[] }>(
			"heartbeat",
		)!;
		expect(beat.servers).toEqual([expect.objectContaining({ name: "fake", connected: true, version: "fake-1" })]);
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
	});
});

describe("the held ledger is reconciled on the heartbeat", () => {
	test("a tick closes the holds of an answered question, a merged PR and a settled thread, and leaves the rest", async () => {
		const gh = async (path: string) =>
			path.endsWith("/pulls/962") ? { state: "closed", merged_at: "2026-11-13T12:50:41Z" } : { state: "open" };
		const r = rig({ housekeeping: true, gh });
		await r.until("connected", () => r.fake.connected);
		const q = {
			id: "Q-tick1",
			kind: "only-you" as const,
			title: "t",
			context: "",
			options: [{ label: "Yes" }],
			thread: "T",
			server: "fake",
			createdAt: "2026-11-13T00:00:00.000Z",
		};
		askQuestion(r.store, q);
		const at = new Date("2026-11-13T01:00:00.000Z");
		appendHeld(r.store, { thread: "answered", what: "waits", item: "Q-tick1" }, at);
		appendHeld(r.store, { thread: "merged", what: "waits", ref: { pr: "o/r#962" } }, at);
		appendHeld(r.store, { thread: "open-pr", what: "waits", ref: { pr: "o/r#963" } }, at);
		appendHeld(r.store, { thread: "settled", what: "waits", ref: { threadId: "th-settled" } }, at);
		appendHeld(r.store, { thread: "prose", what: "merge o/r#962 for me" }, at);
		claimWake(
			r.store,
			pageClaim(q, {
				choice: 0,
				label: "Yes",
				by: "page",
				t: "2026-11-13T02:00:00.000Z",
				deliveryId: "answer:item:Q-tick1",
			}),
		);
		r.fake.emit({ kind: "state", thread: thread("th-settled", "completed", { settled: true }) });
		await r.until("the thread is known", () => r.engine.watchers[0]!.states.has("th-settled"));
		await r.engine.tick();
		expect(
			heldOpen(r.store)
				.map((h) => h.thread)
				.sort(),
		).toEqual(["open-pr", "prose"]);
		expect(r.events.filter((e) => e.event.endsWith("-error"))).toEqual([]);
		expect(r.events.some((e) => e.event === "held-reconciled")).toBe(true);
	});

	// Fix 1. Must fail on 2845f33: the watcher's cache said settled and the hold closed while the server could not be reached.
	test("fix 1: with the server unreachable, a thread the watcher's cache calls settled closes nothing", async () => {
		const r = rig({ housekeeping: true });
		await r.until("connected", () => r.fake.connected);
		appendHeld(
			r.store,
			{ thread: "cached-settled", what: "waits", ref: { threadId: "th-settled" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
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
		appendHeld(
			r.store,
			{ thread: "deleted", what: "waits", server: "fake", ref: { threadId: "th-deleted" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		appendHeld(
			r.store,
			{ thread: "listed", what: "waits", server: "fake", ref: { threadId: "th-listed" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		appendHeld(
			r.store,
			{ thread: "unnamed", what: "waits", ref: { threadId: "th-deleted" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
		r.fake.emit({ kind: "state", thread: thread("th-listed", "running") });
		await r.engine.tick();
		expect(
			heldOpen(r.store)
				.map((h) => h.thread)
				.sort(),
		).toEqual(["listed", "unnamed"]);
	});

	test("fix 1: an adapter that cannot take a snapshot leaves its threads unknown", async () => {
		const r = rig({ housekeeping: true, capabilities: [] });
		await r.until("connected", () => r.fake.connected);
		appendHeld(
			r.store,
			{ thread: "h", what: "waits", ref: { threadId: "th-gone" } },
			new Date("2026-11-13T01:00:00.000Z"),
		);
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
		expect(r.store.items.get("notification-log", "req:fake:req-1")).toMatchObject({
			kind: "sent",
			status: "triggered",
			notificationCount: 1,
		});
		expect(r.engine.notified().has("req:fake:req-1")).toBe(true);
		r.engine.alarm("steward-stalled", "stalled", "it is");
		r.engine.alarm("steward-stalled", "stalled", "it is");
		expect(r.events.filter((e) => e.event === "alarm")).toHaveLength(1);
		expect(r.store.items.get("alarm", "steward-stalled")).toMatchObject({
			kind: "alarm",
			status: "triggered",
			notificationCount: 1,
		});
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
		r.fake.probe = {
			readable: true,
			contextTokens: 5000,
			compactBlocked: "one is already queued or running",
			stalled: { title: "The Steward has stopped taking wakes", summary: "2 wakes queued" },
		};
		await r.engine.tick();
		expect(r.fake.compactions).toEqual([]);
		expect(r.events.find((e) => e.event === "skip-compact")).toMatchObject({
			reason: "one is already queued or running",
		});
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

// ---- a notification decision and its wake are one transaction -----------------------------------

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
			enqueue: (...a: Parameters<Store["wakes"]["enqueue"]>) => {
				if (fail.at === "enqueue") throw Error("the disk went away");
				return s.wakes.enqueue(...a);
			},
			hold: (...a: Parameters<Store["wakes"]["hold"]>) => {
				if (fail.at === "held-push") throw Error("the disk went away");
				return s.wakes.hold(...a);
			},
		},
		items: {
			...s.items,
			observe: (o) => {
				if (fail.at === "hold-item" && o.source === "held") throw Error("the disk went away");
				return s.items.observe(o);
			},
		},
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
		expect([...r.engine.notified()].sort()).toEqual(expect.arrayContaining(["req:fake:req-1"]));
		expect(r.store.wakes.rows()).toEqual([]);
	});

	test("a held turn end: the same, through the held store", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, steward: "steward-1" });
		const ended = () => {
			r.fake.threads.set("t9", {
				instruction: { items: [{ ...stewardSigned, id: "s-t9" }], state: "complete", byMachine: false },
				lastMessage: "t9 finished the work.",
			});
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
		expect(r.fake.wakes[0]!.message).toContain(
			'thread "Thread t9" finished a turn on the work you sent it and has gone quiet.',
		);
	});

	test("a sweep finding: when the wake cannot be queued, the finding is not recorded as notified and the clock does not move, so the next sweep wakes with it", async () => {
		const { fail, wrap } = flaky();
		const r = rig({ wrap, housekeeping: true });
		r.priv(
			"sweep.json",
			JSON.stringify({
				checks: [
					{
						name: "disk",
						command: ["/bin/echo", JSON.stringify([{ dedupKey: "root", text: "the root disk is 97% full" }])],
					},
				],
			}),
		);
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

	describe("the idle-parents timer: its own schedule, apart from the routine sweep", () => {
		const idleRig = (conf?: object, classifierProvider?: EngineDeps["classifierProvider"]) => {
			const r = rig({ housekeeping: true, steward: "stew", ...(classifierProvider ? { classifierProvider } : {}) });
			if (conf) r.priv("sweep.json", JSON.stringify(conf));
			/** A last message that finished `min` minutes before the engine's clock. */
			const ago = (min: number, text: string, id = "m1") => ({
				id,
				text,
				at: new Date(r.clock.t - min * 60_000).toISOString(),
			});
			const seen = (id: string, status: string, over: Partial<ThreadInput>, last = ago(180, "All done.")) => {
				r.fake.threads.set(id, { lastAssistant: last });
				r.fake.emit({ kind: "state", thread: thread(id, status, over) });
			};
			const runs = () => r.events.filter((e) => e.event === "idle-parents").length;
			const sweeps = () => r.events.filter((e) => e.event === "sweep").length;
			/** Time passes for the engine's own clock; the message ages move with it. */
			const pass = (min: number) => {
				r.clock.t += min * 60_000;
			};
			return { r, ago, seen, runs, sweeps, pass };
		};

		test("idle top-level threads reach the Steward, asks first, and the rest are filtered out", async () => {
			const { r, ago, seen } = idleRig();
			// The real miss: it ended on a go-phrase, with no card and no open PR.
			seen(
				"ask",
				"idle",
				{},
				ago(240, "The token is in.\n\n🗣️ The breaker still needs its endpoint; say go and I'll start it."),
			);
			seen("plain", "completed", {}, ago(120, "Finished the report."));
			seen("fresh", "idle", {}, ago(10, "Just now."));
			seen("edge", "idle", {}, ago(29, "Just under the threshold."));
			seen("child", "idle", { parentThreadId: "ask" });
			seen("settled", "idle", { settled: true });
			seen("snoozed", "idle", { snoozed: true });
			seen("working", "running", {});
			seen("stew", "idle", {});
			await r.quiet();
			await r.engine.tick();
			await r.until("the idle wake", () => r.fake.wakes.length === 1);
			const msg = r.fake.wakes[0]!.message;
			expect(msg).toContain("[chamberlain] idle threads: 2 top-level threads finished and went quiet");
			expect(msg).toContain('[ASKING] thread "Thread ask" on fake (threadId ask), idle 240 min.');
			expect(msg).toContain('thread "Thread plain" on fake (threadId plain), idle 120 min.');
			expect(msg.indexOf("threadId ask")).toBeLessThan(msg.indexOf("threadId plain"));
			for (const id of ["fresh", "edge", "child", "settled", "snoozed", "working", "stew"])
				expect(msg).not.toContain(`threadId ${id})`);
		});

		test("it fires on its own interval, not the routine sweep's, and dedupe holds across ticks", async () => {
			const { r, ago, seen, runs, sweeps, pass } = idleRig();
			seen("ask", "idle", {}, ago(240, "Say go and I'll start it."));
			seen("plain", "completed", {}, ago(120, "Finished the report."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the first wake", () => r.fake.wakes.length === 1);
			expect([runs(), sweeps()]).toEqual([1, 1]);
			// Fourteen minutes later it is not due; a tick does not run it.
			pass(14);
			await r.engine.tick();
			expect([runs(), sweeps()]).toEqual([1, 1]);
			// Sixteen minutes in it is due on its own, while the two-hourly sweep is not. Nothing new: no wake.
			pass(2);
			await r.engine.tick();
			expect([runs(), sweeps()]).toEqual([2, 1]);
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
			// Many more ticks and intervals, the same last messages: still one wake.
			for (let n = 0; n < 4; n++) {
				pass(16);
				await r.engine.tick();
			}
			expect(runs()).toBe(6);
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
			// One thread says something new: the next due tick reports that thread alone.
			r.fake.threads.set("plain", { lastAssistant: ago(40, "Merged it.", "m2") });
			pass(16);
			await r.engine.tick();
			await r.until("the second wake", () => r.fake.wakes.length === 2);
			expect(r.fake.wakes[1]!.message).toContain("Merged it.");
			expect(r.fake.wakes[1]!.message).not.toContain("threadId ask)");
			expect(r.fake.wakes[1]!.message).toContain("1 top-level thread finished");
			// The interval survives a restart: it is the check's own clock in the database.
			expect(r.store.state.get("idle-parents-clock")).toMatchObject({ lastAt: r.clock.t });
		});

		test("a thread the principal started the last turn on is reported too: selection never looks at who instructed it", async () => {
			const { r, ago } = idleRig();
			const principalSaid = (minAgo: number) => ({
				type: "user_message",
				id: "u1",
				text: "what is the state of the migration?",
				createdBy: "user",
				creationSource: "web",
				updatedAt: new Date(r.clock.t - minAgo * 60_000).toISOString(),
			});
			// The answer to the principal's own question, ended on a half-answer, and then nothing for hours.
			r.fake.threads.set("chat", {
				instruction: { items: [principalSaid(200)], state: "complete", byMachine: false },
				lastAssistant: ago(190, "Part of it is done; the rest needs a look at the logs."),
			});
			r.fake.emit({ kind: "state", thread: thread("chat", "idle") });
			// The same thread, answered just over the threshold ago, is reported at 31 minutes and not at 29.
			r.fake.threads.set("recent", {
				instruction: { items: [principalSaid(45)], state: "complete", byMachine: false },
				lastAssistant: ago(31, "Here is the answer."),
			});
			r.fake.emit({ kind: "state", thread: thread("recent", "completed") });
			r.fake.threads.set("justnow", {
				instruction: { items: [principalSaid(35)], state: "complete", byMachine: false },
				lastAssistant: ago(29, "Here is the answer."),
			});
			r.fake.emit({ kind: "state", thread: thread("justnow", "completed") });
			await r.quiet();
			await r.engine.tick();
			await r.until("the idle wake", () => r.fake.wakes.length === 1);
			const msg = r.fake.wakes[0]!.message;
			expect(msg).toContain('thread "Thread chat" on fake (threadId chat), idle 190 min.');
			expect(msg).toContain("(threadId recent), idle 31 min.");
			expect(msg).not.toContain("threadId justnow)");
			// The turn-ended skip for such a thread is untouched: a live chat turn still wakes nobody.
			r.fake.emit({ kind: "state", thread: thread("live", "running") });
			r.fake.threads.set("live", {
				instruction: { items: [principalSaid(1)], state: "complete", byMachine: false },
				lastMessage: "Answered.",
			});
			r.fake.emit({ kind: "state", thread: thread("live", "completed") });
			await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
			expect(r.fake.wakes).toHaveLength(1);
		});

		test("a parent with a running subagent that only the inspector knows of gets no finding and no wake (a review finding)", async () => {
			const { r, ago, runs } = idleRig();
			r.fake.threads.set("parent", { lastAssistant: ago(90, "Handed the work to a subagent."), subagents: 1 });
			r.fake.emit({ kind: "state", thread: thread("parent", "idle") });
			await r.quiet();
			await r.engine.tick();
			await r.quiet();
			expect(runs()).toBe(1);
			expect(r.fake.wakes).toEqual([]);
			expect(r.store.items.list({ source: "check:idle-parents" })).toEqual([]);
			// When the subagent finishes, the same parent is reported at its next run.
			r.fake.threads.set("parent", { lastAssistant: ago(90, "Handed the work to a subagent."), subagents: 0 });
			r.clock.t += 16 * 60_000;
			await r.engine.tick();
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("threadId parent)");
		});

		test("a thread snoozed for one run and back with the same last message is not reported a second time (a review finding)", async () => {
			const { r, ago, seen, pass } = idleRig();
			seen("a", "idle", {}, ago(120, "Say go and I'll start it."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the first wake", () => r.fake.wakes.length === 1);
			for (const snoozed of [true, false, true, false]) {
				pass(16);
				r.fake.emit({ kind: "state", thread: thread("a", "idle", { snoozed }) });
				await r.engine.tick();
			}
			await r.quiet();
			expect(r.fake.wakes).toHaveLength(1);
		});

		test("the interval and the threshold are configurable", async () => {
			const { r, ago, seen, runs, pass } = idleRig({ idleParents: { intervalMinutes: 5, thresholdMinutes: 100 } });
			seen("old", "idle", {}, ago(130, "Old news."));
			seen("mid", "idle", {}, ago(60, "Not idle enough."));
			await r.quiet();
			await r.engine.tick();
			await r.until("the wake", () => r.fake.wakes.length === 1);
			expect(r.fake.wakes[0]!.message).toContain("threadId old)");
			expect(r.fake.wakes[0]!.message).not.toContain("threadId mid)");
			pass(4);
			await r.engine.tick();
			expect(runs()).toBe(1);
			pass(1);
			await r.engine.tick();
			expect(runs()).toBe(2);
		});

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
	const STREAM: RunFailure = {
		runId: "run-1",
		class: "unknown",
		message: "The provider event stream closed unexpectedly. Retry the turn.",
	};
	const FAST = {
		graceMs: 40,
		rateLimitWaitMs: 80,
		secondFailureWindowMs: 5_000,
		breakerWindowMs: 5_000,
		breakerQuietMs: 5_000,
	};
	const m1: TurnItem = {
		type: "user_message",
		id: "m1",
		text: "do the thing",
		createdBy: "user",
		creationSource: "user",
	};
	/** A rig whose engine has recovery on, with fast timing and a judge that answers from the test. */
	function make(
		judged: { verdict: string; reason: string } | "fail" = { verdict: "do_not_retry", reason: "it keeps failing" },
	) {
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
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => clock.t },
			recover: FAST,
			ask: async (raw) => {
				asked.push(raw as Record<string, any>);
			},
			judge: async (trigger, brief) => {
				judgeCalls.push({ trigger, brief });
				return judged === "fail"
					? { ok: false, backend: "small-model", error: "small-model judge exited 1" }
					: { ok: true, backend: "small-model", ...judged };
			},
		});
		engines.push(engine);
		void engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > end)
					throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
				await Bun.sleep(5);
			}
		};
		const failRun = (id: string, runId: string, failure: RunFailure, over: Partial<ThreadInput> = {}) => {
			fake.threads.set(id, {
				...(fake.threads.get(id) ?? {}),
				failure,
				instruction: { items: [m1], state: "complete", byMachine: false },
			});
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

	test("a never-retry failure wakes the Steward at once, naming why, and sends nothing", async () => {
		const x = make();
		x.failRun("t1", "run-1", {
			runId: "run-1",
			class: "provider_error",
			code: "api_error_403",
			message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		});
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain("not retried automatically: a 403 / Cloudflare block");
		await x.quiet();
		expect(x.fake.sends).toEqual([]);
	});

	test("a waiting thread, and the Steward's own thread, are never retried", async () => {
		const x = make();
		x.failRun("w", "run-1", STREAM, { backgroundTasks: 1 });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain(
			"not retried automatically: waiting: a watch, gate or background task is parked",
		);
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
	});

	test("three failures of one kind raise exactly one alarm through the decision queue, and stop every retry", async () => {
		const x = make();
		for (const [i, id] of ["a", "b", "c"].entries())
			x.failRun(id, `run-${i + 1}`, { ...STREAM, runId: `run-${i + 1}` });
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
		expect(r.fake.wakes[0]!.message).toContain("run failed.");
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		expect(r.fake.sends).toEqual([]);
	});
});

describe("recovery is OFF unless asked for, and the production launcher asks only with `recover` (CHAMBERLAIN_RECOVER=1 or config.json)", () => {
	test("an engine built without `recover` keeps the plain failed wake and retries nothing", async () => {
		const r = rig();
		r.fake.threads.set("t1", {
			failure: { runId: "run-1", class: "unknown", message: "The provider event stream closed unexpectedly." },
		});
		r.fake.emit({ kind: "state", thread: thread("t1", "running", { latestRunId: "run-1" }) });
		r.fake.emit({ kind: "state", thread: thread("t1", "failed", { latestRunId: "run-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("run failed.");
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		await r.quiet(150);
		expect(r.fake.sends).toEqual([]);
		expect(r.store.state.get("recover")).toBeUndefined();
	});
	test("the daemon launcher turns it on only for `recover` being true", () => {
		const src = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
		expect(src).toContain('recover: setting("recover", CONF) === true');
	});
});

describe("wakes carry the rights and rulings only when they changed", () => {
	const waitingOn = (r: ReturnType<typeof rig>, id: string, req: string) => {
		r.fake.threads.set(id, { waiting: [{ ...question, requestId: req }] });
		r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
	};
	test("unchanged rights give the one-line pointer, and a toggle of away mode never re-sends the block", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the second wake", () => r.fake.wakes.length === 2);
		const pointer = r.fake.wakes[1]!.message.split("\n").filter((l) =>
			l.startsWith("Decision rights and rulings unchanged since"),
		);
		expect(pointer).toHaveLength(1);
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights (standing rules):");
		// Away on: the mandate rides the wake, the block still does not.
		r.store.away.enter({ enteredAt: new Date().toISOString(), words: "back at five" });
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the away wake", () => r.fake.wakes.length === 3);
		expect(r.fake.wakes[2]!.message).not.toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[2]!.message).toContain(pointer[0]!);
		expect(r.fake.wakes[2]!.message).toContain("back at five");
		// Away off: still the pointer.
		r.store.away.exit(new Date().toISOString());
		r.fake.probe = { readable: true, contextTokens: 4000 };
		waitingOn(r, "t4", "req-4");
		await r.until("the wake after", () => r.fake.wakes.length === 4);
		expect(r.fake.wakes[3]!.message).not.toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[3]!.message).toContain(pointer[0]!);
	});

	test("a changed ruling sends the full block again", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the second wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights (standing rules):");
		r.priv("decision-rights.md", "The Steward may merge green PRs and nothing else.");
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the third wake", () => r.fake.wakes.length === 3);
		expect(r.fake.wakes[2]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[2]!.message).toContain("and nothing else.");
	});

	test("a full-block wake that is dead-lettered leaves the record unset, and the next wake carries the full block again", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		r.fake.setWakeStatus(() => 503);
		waitingOn(r, "t1", "req-1");
		await r.until("the dead letter", () => r.store.wakes.rows("dead_letter").length === 1);
		expect(r.fake.attempts).toBe(3);
		expect(r.fake.wakes).toEqual([]);
		// The block it carried never reached the Steward, so nothing says the Steward holds it.
		expect(r.store.state.get("rights-sent")).toBeUndefined();
		r.fake.setWakeStatus(() => 202);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[0]!.message).not.toContain("Decision rights and rulings unchanged since");
	});
});

describe("a queued rights pointer is checked against the Steward it is about to reach", () => {
	const waitingOn = (r: ReturnType<typeof rig>, id: string, req: string) => {
		r.fake.threads.set(id, { waiting: [{ ...question, requestId: req }] });
		r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
	};
	/** One full wake delivered, then a pointer queued while the webhook has nowhere to send: it sits pending. */
	async function pointerQueued() {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		r.fake.setWakeReady(false);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the pointer row", () => r.store.wakes.rows().length === 1);
		const row = r.store.wakes.rows()[0]!;
		expect(row.message).toContain("Decision rights and rulings unchanged since");
		expect(row.message).not.toContain("Decision rights (standing rules):");
		return { r, row };
	}

	/** The wakes after the first full one: the rights-first wake, then the queued row byte for byte (with only its delivery-id line). */
	function rightsThenRow(r: ReturnType<typeof rig>, row: { deliveryId: string; message: string }) {
		const ids = r.fake.wakes.slice(1).map((w) => w.deliveryId);
		expect(ids).toHaveLength(2);
		expect(ids[0]!.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		expect(ids[1]).toBe(row.deliveryId);
		const first = r.fake.wakes[1]!;
		expect(first.message).toContain("Decision rights (standing rules):");
		expect(first.message).toContain("The Steward may merge green PRs.");
		expect(first.message).toContain(`(${row.deliveryId})`);
		expect(r.fake.wakes[2]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		expect(r.store.wakes.find(row.deliveryId)).toMatchObject({ status: "delivered", message: row.message });
		return first;
	}

	test("a new Steward thread before it is sent: the full rights go first, then the pointer row exactly as queued", async () => {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
		expect(r.fake.wakes[2]!.message).toContain("threadId: t2");
		const logged = r.events.find((e) => e.event === "rights-first");
		expect(logged).toMatchObject({ deliveryId: row.deliveryId, first: r.fake.wakes[1]!.deliveryId });
		expect(String(logged!.reason)).toContain("Steward thread");
		// The new Steward now holds them: the next wake is a pointer again, with nothing ahead of it.
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the fourth wake", () => r.fake.wakes.length === 4);
		expect(r.fake.wakes[3]!.message).toContain("Decision rights and rulings unchanged since");
		expect(r.fake.wakes[3]!.deliveryId).not.toContain("rights-first");
	});

	test("a new Steward session in the same thread sends the rights first too", async () => {
		const { r, row } = await pointerQueued();
		r.fake.transcript = { ...r.fake.transcript, session: "session-2" };
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
		expect(String(r.events.find((e) => e.event === "rights-first")!.reason)).toContain("session");
	});

	test("a compaction that cleared the record sends the rights first too", async () => {
		const { r, row } = await pointerQueued();
		r.fake.probe = { readable: true, contextTokens: 10 };
		await r.engine.tick();
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
	});

	test("a full wake in flight, the compaction asked for, the full wake lands: the next wake carries the full rights, never a bare pointer", async () => {
		const r = rig({ steward: "steward-1", compactAt: 5000 });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		let release!: () => void,
			started = false;
		const open = new Promise<void>((res) => {
			release = res;
		});
		const send = r.fake.wake.send;
		r.fake.wake.send = async (id, message) => {
			if (!started) {
				started = true;
				await open;
			}
			return send(id, message);
		};
		waitingOn(r, "t1", "req-1");
		await r.until("the full wake in flight", () => started);
		// Past the size limit while the full wake's POST is open: the compaction is asked for, and waits behind it in the relay's queue.
		r.fake.probe = { readable: true, contextTokens: 6000 };
		const ticking = r.engine.tick();
		await r.until("the compaction asked for", () => r.events.some((e) => e.event === "fire" && e.kind === "compact"));
		release();
		await ticking;
		await r.until("the full wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.compactions).toHaveLength(1);
		// The full wake landed before the compaction's job, which then bumped the epoch: no record survives it.
		expect(r.store.state.get("rights-sent")).toEqual({ epoch: 1 });
		r.fake.probe = { readable: true, contextTokens: 1500 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights and rulings unchanged since");
	});

	test("the plain case: a full wake delivered, then a compaction: the next wake carries the full rights", async () => {
		const r = rig({ steward: "steward-1", compactAt: 5000 });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the full wake", () => r.fake.wakes.length === 1);
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-1", epoch: 0 });
		r.fake.probe = { readable: true, contextTokens: 6000 };
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
		r.fake.probe = { readable: true, contextTokens: 6500 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).toContain("Decision rights (standing rules):");
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-1", epoch: 1 });
	});

	test("the same Steward and record: the pointer is sent as queued, with no extra wake", async () => {
		const { r, row } = await pointerQueued();
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the pointer", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.deliveryId).toBe(row.deliveryId);
		expect(r.fake.wakes[1]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		await r.engine.tick();
		expect(r.fake.wakes).toHaveLength(2);
		expect(r.store.wakes.rows("all").some((w) => w.deliveryId.includes(":rights-first:"))).toBe(false);
		expect(r.events.some((e) => e.event === "rights-first")).toBe(false);
	});

	test("the rights went, the row failed, the Steward changed before the retry: the row waits for the NEW Steward's rights, then goes as queued", async () => {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeStatus((id) => (id === row.deliveryId ? 503 : 202));
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the row's failed attempt", () => (r.store.wakes.find(row.deliveryId)?.attempts ?? 0) >= 1);
		expect(r.fake.wakes.map((w) => w.deliveryId).slice(1)).toHaveLength(1);
		const first = r.fake.wakes[1]!;
		expect(first.deliveryId.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		// Replaced again before the retry: the rights steward-2 got prove nothing for steward-3.
		r.priv("steward-thread", "steward-3");
		r.fake.setWakeStatus(() => 202);
		await r.engine.tick();
		await r.until("the row", () => r.store.wakes.find(row.deliveryId)?.status === "delivered");
		const ids = r.fake.wakes.map((w) => w.deliveryId).slice(1);
		expect(ids).toHaveLength(3);
		expect(ids[1]!.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		expect(ids[1]).not.toBe(first.deliveryId);
		expect(ids[2]).toBe(row.deliveryId);
		expect(r.fake.wakes[3]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-3", session: "session-1" });
	});

	/**
	 * Finding 2, in process: the first engine stops at a point a crash could leave (its store refuses one attempt, as a kill before it would),
	 * then a second engine (the restart) over the same database. The record must be right from the database alone, and a later wake gets the
	 * pointer with nothing ahead of it.
	 */
	async function restartAfter(stopAt: "prerequisite queued" | "prerequisite delivered") {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		let blocked = false;
		const refuse = (id: number) => {
			const w = r.store.wakes.rows("all").find((x) => x.id === id);
			const hit =
				stopAt === "prerequisite queued" ? w?.deliveryId.includes(":rights-first:") : w?.deliveryId === row.deliveryId;
			if (hit) {
				blocked = true;
				throw Error("killed");
			}
		};
		const store: Store = {
			...r.store,
			wakes: {
				...r.store.wakes,
				beginAttempt: (id, now) => {
					refuse(id);
					return r.store.wakes.beginAttempt(id, now);
				},
			},
		};
		return {
			r,
			row,
			store,
			refuse: async () => {
				// The engine under test is restarted on the refusing store: it queues (and maybe delivers) the prerequisite, and stops there.
				await r.engine.stop();
				const first = rig({ store: r.store, wrap: () => store, steward: "steward-2" });
				first.fake.probe = { readable: true, contextTokens: 3000 };
				await first.until("the stop", () => blocked);
				await first.engine.stop();
				return first;
			},
		};
	}
	for (const stopAt of ["prerequisite queued", "prerequisite delivered"] as const) {
		test(`finding 2: a restart after the ${stopAt}: the record is right, the row goes once, and a later wake gets the pointer`, async () => {
			const { row, refuse } = await restartAfter(stopAt);
			const first = await refuse();
			const prereq = first.store.wakes.rows("all").filter((w) => w.deliveryId.includes(":rights-first:"));
			expect(prereq).toHaveLength(1);
			expect(prereq[0]!.status).toBe(stopAt === "prerequisite queued" ? "pending" : "delivered");
			expect(first.store.wakes.find(row.deliveryId)).toMatchObject({ status: "pending", attempts: 0 });
			const again = rig({ store: first.store, steward: "steward-2" });
			again.fake.probe = { readable: true, contextTokens: 4000 };
			await again.until("the row", () => again.store.wakes.find(row.deliveryId)?.status === "delivered");
			const sent = again.fake.wakes.map((w) => w.deliveryId);
			expect(sent).toEqual(
				stopAt === "prerequisite queued" ? [prereq[0]!.deliveryId, row.deliveryId] : [row.deliveryId],
			);
			expect(again.fake.wakes.at(-1)!.message).toBe(withDeliveryId(row.message, row.deliveryId));
			expect(again.store.state.get("rights-sent")).toMatchObject({
				steward: "steward-2",
				session: "session-1",
				hash: prereq[0]!.rights![0]!.hash,
			});
			expect(again.store.wakes.rows("all").filter((w) => w.deliveryId.includes(":rights-first:"))).toHaveLength(1);
			again.fake.probe = { readable: true, contextTokens: 5000 };
			again.fake.threads.set("t9", { waiting: [{ ...question, requestId: "req-9" }] });
			again.fake.emit({ kind: "needs_input", thread: thread("t9", "waiting", { pendingRequestId: "req-9" }) });
			await again.until("the later wake", () => again.fake.wakes.some((w) => w.message.includes("threadId: t9")));
			const later = again.fake.wakes.at(-1)!;
			expect(later.message).toContain("Decision rights and rulings unchanged since");
			expect(later.message).not.toContain("Decision rights (standing rules):");
			expect(again.fake.wakes.at(-2)!.deliveryId).toBe(row.deliveryId);
		});
	}

	test("a question that quotes the pointer line itself is delivered byte for byte after a Steward replacement", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		const at = (r.store.state.get("rights-sent") as { at: string }).at;
		const quoted = `Is "${pointerAt(at)}" safe to quote, and what of "${pointerAt("whenever")}"?`;
		r.fake.setWakeReady(false);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		r.fake.threads.set("t2", {
			waiting: [{ ...question, requestId: "req-2", questions: [{ question: quoted, options: [{ label: "Yes" }] }] }],
		});
		r.fake.emit({ kind: "needs_input", thread: thread("t2", "waiting", { pendingRequestId: "req-2" }) });
		await r.until("the pointer row", () => r.store.wakes.rows().length === 1);
		const row = r.store.wakes.rows()[0]!;
		expect(row.message).toContain(quoted);
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
		expect(r.fake.wakes[2]!.message).toContain(quoted);
	});
});

/** The three "rights unchanged" pointer lines the daemon wrote before migration 9 stamped them, verbatim from git history. */
const POINTER_545334A =
	"Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";
const POINTER_V010 =
	"Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md in the config directory, and the rulings in force are listed in the hand-off (`bun src/brief.ts steward`).";
const pointerAt = (at: string) =>
	`Decision rights and rulings unchanged since ${at} and still in force; your hand-off (steward-brief.md) has them.`;

describe("a Steward wake queued before the stamps existed is never sent to a new Steward without the rights", () => {
	/** A database file at schema `version` (the real migrations, nothing newer), with these rows pending, then opened by this build. */
	function oldDb(version: number, rows: { id: string; message: string }[]): Store {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-legacy-`);
		dirs.push(root);
		const path = `${root}/v${version}.db`;
		const raw = new Database(path);
		raw.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
			raw.exec(m.sql);
			raw.query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 'then')").run(m.version, m.name);
		}
		rows.forEach((r, i) => {
			raw
				.query(
					"INSERT INTO outbox (id, delivery_id, message, kind, thread, created_at) VALUES (?, ?, ?, 'needs_input', ?, ?)",
				)
				.run(i + 1, r.id, r.message, `t${i + 1}`, Date.now());
			raw
				.query(
					"INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) VALUES (?, ?, ?, 'needs_input', ?)",
				)
				.run(r.id, i + 1, Date.now(), `t${i + 1}`);
		});
		raw.close();
		return openStore(path);
	}
	const wakeText = (pointer: string) =>
		`Chamberlain: a thread is waiting on you.\nthreadId: t1\n${pointer}\nAway mode is off.`;
	/** Open the old database under this build, replace the Steward, and let the relay send. */
	async function upgradeAndReplace(store: Store, n: number) {
		const fake = createFakeAdapter();
		fake.setWakeReady(false);
		const r = rig({ store, adapter: fake, steward: "steward-1" });
		await r.until("startup", () => r.events.some((e) => e.event === "startup-recovered"));
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the wakes", () => r.fake.wakes.length === n);
		return r;
	}

	for (const version of [7, 8, 9]) {
		for (const [label, pointer] of [
			["545334a pointer", POINTER_545334A],
			["v0.1.0 pointer", POINTER_V010],
			["dated pointer", pointerAt("2026-11-13T18:00:00.000Z")],
		] as const) {
			test(`schema ${version}, ${label}: upgrade, replace the Steward, deliver: the full rights first, then the row unchanged`, async () => {
				const message = wakeText(pointer);
				const r = await upgradeAndReplace(oldDb(version, [{ id: "old-pointer", message }]), 2);
				expect(r.fake.wakes.map((w) => w.deliveryId.replace(/:rights-first:.*/, ":rights-first"))).toEqual([
					"old-pointer:rights-first",
					"old-pointer",
				]);
				expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
				expect(r.fake.wakes[0]!.message).toContain("The Steward may merge green PRs.");
				expect(r.fake.wakes[1]!.message).toBe(withDeliveryId(message, "old-pointer"));
				expect(r.store.wakes.find("old-pointer")).toMatchObject({ status: "delivered", message });
				const logged = r.events.find((e) => e.event === "rights-first");
				expect(logged).toMatchObject({ deliveryId: "old-pointer", first: r.fake.wakes[0]!.deliveryId });
				expect(String(logged!.reason)).toContain("no full-rights wake");
				// The rights-first wake's record is kept: the next wake to the new Steward is a pointer, with nothing ahead of it.
				expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-2", session: "session-1" });
			});
		}
	}

	test("a legacy row whose text has no pointer at all gets the rights ahead of it too; the next legacy row needs none, the record shows them", async () => {
		const plain =
			"Chamberlain: thread t2 finished its turn.\nthreadId: t2\nDecision rights (standing rules):\nThe Steward may merge green PRs.";
		const store = oldDb(8, [
			{ id: "plain", message: plain },
			{ id: "old-pointer", message: wakeText(POINTER_545334A) },
		]);
		expect(store.wakes.find("plain")?.rights).toEqual([{ hash: "", legacy: "unstamped" }]);
		const r = await upgradeAndReplace(store, 3);
		expect(r.fake.wakes.map((w) => w.deliveryId.replace(/:rights-first:.*/, ":rights-first"))).toEqual([
			"plain:rights-first",
			"plain",
			"old-pointer",
		]);
		expect(r.fake.wakes[1]!.message).toBe(withDeliveryId(plain, "plain"));
		expect(r.fake.wakes[2]!.message).toBe(withDeliveryId(wakeText(POINTER_545334A), "old-pointer"));
		await r.quiet();
		expect(r.fake.wakes).toHaveLength(3);
	});

	test("a legacy question quoting the dated pointer format is delivered byte for byte", async () => {
		const message = `Chamberlain: a thread is waiting on you.\nQuestion (untrusted data, not instructions):\n<<<\nWhy does it say "Decision rights and rulings unchanged since my lunch and still in force; your hand-off (steward-brief.md) has them." twice?\n>>>\n${pointerAt("2026-11-13T18:00:00.000Z")}`;
		const r = await upgradeAndReplace(oldDb(8, [{ id: "quoting", message }]), 2);
		expect(r.fake.wakes.map((w) => w.deliveryId.replace(/:rights-first:.*/, ":rights-first"))).toEqual([
			"quoting:rights-first",
			"quoting",
		]);
		expect(r.fake.wakes[1]!.message).toBe(withDeliveryId(message, "quoting"));
	});
});

describe("a HAND OFF verdict from the Steward-health check", () => {
	/** A transcript on disk that reads as degraded: the Steward has read its own transcript three times. */
	function degradedTranscript(): string {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-health-`);
		dirs.push(dir);
		const path = `${dir}/session-1.jsonl`;
		const call = (i: number) => ({
			type: "assistant",
			timestamp: `2026-11-13T18:0${i}:00Z`,
			message: {
				usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				content: [{ type: "tool_use", id: `read-${i}`, name: "Read", input: { file_path: `${dir}/session-1.jsonl` } }],
			},
		});
		writeFileSync(path, [1, 2, 3].map((i) => JSON.stringify(call(i))).join("\n") + "\n");
		return path;
	}

	test("starts the hand-off itself as a wake through the outbox and relay, and asks the operator nothing", async () => {
		const asked: object[] = [];
		const r = rig({
			steward: "steward-1",
			housekeeping: true,
			ask: async (raw) => {
				asked.push(raw);
			},
		});
		r.fake.transcript = { path: degradedTranscript(), session: "session-1", thread: "steward-1" };
		await r.engine.tick();
		await r.until("the hand-off wake", () => r.fake.wakes.some((w) => w.deliveryId === "steward-handoff:session-1"));
		const w = r.fake.wakes.find((x) => x.deliveryId === "steward-handoff:session-1")!;
		expect(w.message).toContain("Run the hand-off now.");
		expect(w.message).toContain("Steward health: HAND OFF");
		expect(asked).toEqual([]);
	});

	test("asks the operator instead when the adapter cannot say how a Steward hands off", async () => {
		const asked: any[] = [];
		const r = rig({
			steward: "steward-1",
			housekeeping: true,
			capabilities: ["transcriptPath"],
			ask: async (raw) => {
				asked.push(raw);
			},
		});
		r.fake.transcript = { path: degradedTranscript(), session: "session-1", thread: "steward-1" };
		await r.engine.tick();
		await r.until("the question", () => asked.length === 1);
		expect(asked[0].tag).toBe("steward-health:session-1");
		expect(r.fake.wakes.filter((w) => w.deliveryId.startsWith("steward-handoff:"))).toEqual([]);
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
		const engine = createEngine({
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: createFakeAdapter() }],
			log: (event, data) => events.push({ event, ...data }),
			...(o.recover ? { recover: true } : {}),
		});
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
		const events = make({
			recover: true,
			judgeJson: JSON.stringify({
				triggers: { "stalled-recovery": { backend: "small" } },
				backends: { small: { command: ["/bin/false"] } },
			}),
		});
		expect(events.filter((e) => e.event === "judge-off")).toEqual([]);
	});
	test("recovery off: nothing needs a judge, so nothing is said", () => {
		expect(make({ recover: false }).filter((e) => e.event === "judge-off")).toEqual([]);
	});
});

describe("(2)(3) card holds after a restart, and across servers", () => {
	/** An engine on a given store and servers, with no housekeeping: the card reconciler still runs on connect and on every tick. */
	function engineOn(store: Store, servers: { name: string; fake: FakeAdapter }[]) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cardeng-`);
		dirs.push(root);
		mkdirSync(`${root}/conf`, { recursive: true, mode: 0o700 });
		writeFileSync(`${root}/conf/decision-rights.md`, "ask", { mode: 0o600 });
		const events: Logged[] = [];
		const engine = createEngine({
			conf: `${root}/conf`,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: servers.map((x) => ({ server: { name: x.name, adapter: "fake" }, adapter: x.fake })),
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0 },
		});
		engines.push(engine);
		void engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > end)
					throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
				await Bun.sleep(5);
			}
		};
		return { engine, events, until };
	}
	const approvalCard: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };

	test("a card resolved while the daemon was down: the restarted daemon closes its question and hold once it connects", async () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cardrestart-`);
		dirs.push(root);
		const first = openStore(`${root}/chamberlain.db`);
		first.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const fake1 = createFakeAdapter();
		fake1.threads.set("t1", { waiting: [approvalCard] });
		const one = engineOn(first, [{ name: "fake", fake: fake1 }]);
		fake1.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await one.until("the hold", () => one.events.some((e) => e.event === "held-by-daemon"));
		await one.engine.stop();
		engines.splice(engines.indexOf(one.engine), 1);
		first.close();
		// While it was down the card was answered in its thread; the new process never saw the old state.
		const second = openStore(`${root}/chamberlain.db`);
		expect(heldOpen(second)).toHaveLength(1);
		const fake2 = createFakeAdapter();
		fake2.threads.set("t1", { waiting: [], resolved: ["a1"] });
		const two = engineOn(second, [{ name: "fake", fake: fake2 }]);
		await two.until("the card reconciled", () => two.events.some((e) => e.event === "card-reconciled"));
		expect(heldOpen(second)).toEqual([]);
		expect([...questionStates(second).values()].map((q) => q.status)).toEqual(["answered-on-card"]);
		await two.engine.tick();
		expect(two.events.filter((e) => e.event === "card-reconciled")).toHaveLength(1);
		await two.engine.stop();
		engines.splice(engines.indexOf(two.engine), 1);
		second.close();
	});

	test("a card still waiting after the restart stays held; one that disappears stays held; one seen resolved closes on the next tick", async () => {
		const store = memStore();
		store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const fake = createFakeAdapter();
		fake.threads.set("t1", { waiting: [approvalCard] });
		const e = engineOn(store, [{ name: "fake", fake }]);
		fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await e.until("the hold", () => e.events.some((x) => x.event === "held-by-daemon"));
		await e.engine.tick();
		expect(heldOpen(store)).toHaveLength(1);
		// The card drops out of what the read shows: absence is no evidence, so it stays held.
		fake.threads.set("t1", { waiting: [] });
		await e.engine.tick();
		expect(heldOpen(store)).toHaveLength(1);
		// Its own item shows it resolved: the next tick closes it. No clock is compared, so the read may fall in the hold's own
		// millisecond (this test used to compare wall-clock milliseconds and failed when it did).
		fake.threads.set("t1", { waiting: [], resolved: ["a1"] });
		await e.engine.tick();
		expect(heldOpen(store)).toEqual([]);
	});

	test("two servers with the same request ID: both are held, and the one that resolves closes only its own", async () => {
		const store = memStore();
		store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const a = createFakeAdapter(),
			b = createFakeAdapter();
		a.threads.set("ta", { waiting: [approvalCard] });
		b.threads.set("tb", { waiting: [approvalCard] });
		const e = engineOn(store, [
			{ name: "alpha", fake: a },
			{ name: "beta", fake: b },
		]);
		a.emit({ kind: "needs_input", thread: thread("ta", "waiting", { pendingRequestId: "a1" }) });
		b.emit({ kind: "needs_input", thread: thread("tb", "waiting", { pendingRequestId: "a1" }) });
		await e.until("both holds", () => heldOpen(store).length === 2);
		expect(
			heldOpen(store)
				.map((h) => h.server)
				.sort(),
		).toEqual(["alpha", "beta"]);
		// The card leaves alpha's thread: alpha's question and hold close, beta's stay.
		a.threads.set("ta", { waiting: [], resolved: ["a1"] });
		a.emit({ kind: "state", thread: thread("ta", "running") });
		await e.until("alpha closed", () => heldOpen(store).length === 1);
		await e.engine.tick();
		expect(heldOpen(store).map((h) => h.server)).toEqual(["beta"]);
		expect([...questionStates(store).values()].map((q) => [q.server, q.status]).sort()).toEqual([
			["alpha", "answered-on-card"],
			["beta", "open"],
		]);
	});
});

describe("(A)(D) one thread waiting on two cards keeps a hold per card; the live path closes only the card that left", () => {
	test("the thread's one pending ID moving from a1 to a2 closes nothing while a1 still waits; a1 closes when it stops waiting", async () => {
		const r = rig();
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const a1: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };
		const a2: WaitingItem = { type: "secret_request", requestId: "a2", label: "API_KEY", questions: [] };
		r.fake.threads.set("t1", { waiting: [a1, a2] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("both holds", () => heldOpen(r.store).length === 2);
		expect(
			heldOpen(r.store)
				.map((h) => h.card!.requestId)
				.sort(),
		).toEqual(["a1", "a2"]);
		// The state now names a2, but a1 still waits in the thread: neither its hold nor its question may close.
		r.fake.emit({ kind: "state", thread: thread("t1", "waiting", { pendingRequestId: "a2" }) });
		await r.quiet();
		await r.engine.tick();
		expect(
			heldOpen(r.store)
				.map((h) => h.card!.requestId)
				.sort(),
		).toEqual(["a1", "a2"]);
		expect([...questionStates(r.store).values()].map((q) => q.status)).toEqual(["open", "open"]);
		// a1 is answered in its thread: only a1 closes, hold and question together.
		r.fake.threads.set("t1", { waiting: [a2], resolved: ["a1"] });
		await r.engine.tick();
		expect(heldOpen(r.store).map((h) => h.card!.requestId)).toEqual(["a2"]);
		expect([...questionStates(r.store).values()].map((q) => [q.cardRequest, q.status]).sort()).toEqual([
			["a1", "answered-on-card"],
			["a2", "open"],
		]);
	});
});

describe("a card hold closes only on positive evidence: its own item seen in a terminal status", () => {
	const card: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };
	/** An engine on one fake server holding card a1 on thread t1 while away; the test then changes what a read of t1 says. */
	async function held(o: { mayBeOffline?: boolean; cardUnverifiedAlarmMs?: number } = {}) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cardauth-`);
		dirs.push(root);
		mkdirSync(`${root}/conf`, { recursive: true, mode: 0o700 });
		writeFileSync(`${root}/conf/decision-rights.md`, "ask", { mode: 0o600 });
		const store = memStore();
		store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const fake = createFakeAdapter();
		fake.threads.set("t1", { waiting: [card] });
		const events: Logged[] = [];
		const engine = createEngine({
			conf: `${root}/conf`,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [
				{ server: { name: "fake", adapter: "fake", ...(o.mayBeOffline ? { mayBeOffline: true } : {}) }, adapter: fake },
			],
			log: (event, data) => events.push({ event, ...data }),
			timing: {
				debounceMs: 5,
				lagMs: 5,
				quietMs: 5,
				tickMs: 3_600_000,
				...(o.cardUnverifiedAlarmMs !== undefined ? { cardUnverifiedAlarmMs: o.cardUnverifiedAlarmMs } : {}),
			},
			relay: { retryAfterMs: () => 0 },
		});
		engines.push(engine);
		void engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > end)
					throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
				await Bun.sleep(5);
			}
		};
		fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await until("the hold", () => events.some((e) => e.event === "held-by-daemon"));
		const open = () => ({
			holds: heldOpen(store).length,
			questions: [...questionStates(store).values()].filter((q) => q.status === "open").length,
		});
		return { store, fake, engine, events, open };
	}
	/** A read that says the card is resolved: the evidence that WOULD close it, when it is believed. */
	const emptyNow = () => ({ ok: true as const, cards: [], resolved: ["a1"] });

	test("a disconnect, then an empty list: neither a read while disconnected nor one that spans the disconnect closes anything", async () => {
		const h = await held();
		// The server drops, and the backend would now list nothing: the watcher is not connected, so nothing is read or believed.
		h.fake.setConnected(false);
		h.fake.threads.set("t1", { waitingRead: emptyNow });
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		// Back up (the card still waits), then the socket drops while a read is out and that read answers "nothing waiting": not believed.
		h.fake.threads.set("t1", { waiting: [card] });
		h.fake.setConnected(true);
		await h.engine.tick();
		await Bun.sleep(2);
		// Once only: the reconnection itself asks for another pass, which reads the card still waiting.
		let dropped = false;
		h.fake.threads.set("t1", {
			waitingRead: () => {
				if (dropped) return { ok: true, cards: [card] };
				dropped = true;
				h.fake.setConnected(false);
				h.fake.setConnected(true);
				return emptyNow();
			},
		});
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		expect(h.events.some((e) => e.event === "card-reconciled")).toBe(false);
	});

	test("a mayBeOffline server that is offline: an empty answer is never a listing, and nothing closes", async () => {
		const h = await held({ mayBeOffline: true });
		h.fake.setConnected(false);
		let asked = 0;
		h.fake.threads.set("t1", {
			waitingRead: () => {
				asked++;
				return emptyNow();
			},
		});
		await h.engine.tick();
		await h.engine.tick();
		expect(asked).toBe(0);
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		// Logged once for the episode, not once a tick.
		expect(h.events.filter((e) => e.event === "card-read-unavailable")).toHaveLength(1);
	});

	test("a thrown read closes nothing, is logged once, and recovery closes the card once", async () => {
		const h = await held();
		h.fake.threads.set("t1", { waitingError: "socket hung up" });
		await h.engine.tick();
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		expect(h.events.filter((e) => e.event === "card-read-unavailable").map((e) => e.reason)).toEqual([
			"socket hung up",
		]);
		// The read works again and shows the card's own item resolved: it closes, hold and question, exactly once.
		h.fake.threads.set("t1", { waiting: [], resolved: ["a1"] });
		await h.engine.tick();
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 0, questions: 0 });
		expect(h.events.filter((e) => e.event === "card-reconciled")).toHaveLength(1);
		expect(h.events.filter((e) => e.event === "card-read-recovered")).toHaveLength(1);
	});

	test("a read that breaks the WaitingRead contract closes nothing", async () => {
		const h = await held();
		h.fake.threads.set("t1", {
			waitingRead: (() => ({ ok: true, cards: undefined })) as unknown as () => ReturnType<typeof emptyNow>,
		});
		await h.engine.tick();
		h.fake.threads.set("t1", {
			waitingRead: (() => ({ ok: true, cards: [{ type: "approval_request" }] })) as unknown as () => ReturnType<
				typeof emptyNow
			>,
		});
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
	});

	test("no snapshot exception: the thread missing from a whole snapshot, partial or archived, closes nothing while its read fails", async () => {
		const h = await held();
		let snapshots = 0;
		const snap = h.fake.snapshot!.bind(h.fake);
		h.fake.snapshot = async () => {
			snapshots++;
			return snap();
		};
		h.fake.threads.set("t1", { waitingRead: { ok: false, reason: "thread not found" } });
		// Gone from a whole snapshot.
		h.fake.unlist("t1");
		await h.engine.tick();
		// Gone from a partial one.
		h.fake.snapshotComplete = false;
		await h.engine.tick();
		// Listed, but archived.
		h.fake.snapshotComplete = true;
		h.fake.emit({ kind: "state", thread: thread("t1", "idle", { archived: true }) });
		await h.engine.tick();
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		expect(h.events.some((e) => e.event === "card-reconciled")).toBe(false);
		// The card path never asks for a snapshot at all.
		expect(snapshots).toBe(0);
	});

	test("an unverifiable hold raises an alarm after the period, naming the hold, the card and the hand close; the operator closes it", async () => {
		const h = await held({ cardUnverifiedAlarmMs: 0 });
		h.fake.threads.set("t1", { waitingRead: { ok: false, reason: "thread not found" } });
		await h.engine.tick();
		const alarm = h.store.items.get("alarm", "card-unverified:fake:a1");
		expect(alarm?.status).toBe("triggered");
		expect(h.events.filter((e) => e.event === "alarm" && e.key === "card-unverified:fake:a1")).toHaveLength(1);
		const logged = h.events.find((e) => e.event === "card-unverified")!;
		expect(logged).toMatchObject({
			server: "fake",
			requestId: "a1",
			threadId: "t1",
			holds: [expect.any(String)],
			reason: "thread not found",
		});
		// The repeat policy spaces the alarm: a second tick at once raises it again without a second notification.
		await h.engine.tick();
		expect(h.events.filter((e) => e.event === "alarm" && e.key === "card-unverified:fake:a1")).toHaveLength(1);
		expect(h.open()).toEqual({ holds: 1, questions: 1 });
		// The hand close: hold and question together; the alarm ends and is not raised again.
		expect(closeCardByHand(h.store, "fake", "a1", "the thread was deleted")).toEqual({ questions: 1, holds: 1 });
		expect(h.store.items.get("alarm", "card-unverified:fake:a1")?.status).toBe("resolved");
		const before = h.events.filter((e) => e.event === "card-unverified").length;
		await h.engine.tick();
		expect(h.events.filter((e) => e.event === "card-unverified")).toHaveLength(before);
		expect(h.open()).toEqual({ holds: 0, questions: 0 });
	});

	test("a card item the adapter skipped is logged once and is not 'nothing waiting': the wake still goes", async () => {
		const r = rig();
		r.fake.threads.set("t3", {
			waitingRead: { ok: true, cards: [], resolved: [], ignored: ["card item 0 (approval_request) a9 has no status"] },
		});
		r.fake.emit({ kind: "needs_input", thread: thread("t3", "waiting") });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.events.some((e) => e.event === "skip-empty-wait")).toBe(false);
		expect(r.events.filter((e) => e.event === "card-item-ignored").map((e) => e.reason)).toEqual([
			"card item 0 (approval_request) a9 has no status",
		]);
	});

	test("a failed waiting read is not 'nothing waiting' on the needs-input path either: the wake still goes", async () => {
		const r = rig();
		r.fake.threads.set("t2", { waitingError: "socket hung up" });
		r.fake.emit({ kind: "needs_input", thread: thread("t2", "waiting") });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.events.some((e) => e.event === "skip-empty-wait")).toBe(false);
		expect(r.events.some((e) => e.event === "read-failed" && e.what === "waiting items")).toBe(true);
	});
});

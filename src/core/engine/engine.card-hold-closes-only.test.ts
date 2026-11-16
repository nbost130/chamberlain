/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import type { Logged } from "../../testing/core-engine-fixtures.ts";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import type { WaitingItem } from "../adapter/adapter-waiting.ts";
import { closeCardByHand } from "../items/card-hold.ts";
import { questionStates } from "../items/questions.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { dirs, engines, rig, thread } = useCoreEngineFixtures(createEngine);

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
		expect(closeCardByHand(h.store, { server: "fake", requestId: "a1" }, "the thread was deleted")).toEqual({
			questions: 1,
			holds: 1,
		});
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

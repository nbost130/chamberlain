/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import type { Logged } from "../../testing/core-engine-fixtures.ts";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter, type FakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import type { WaitingItem } from "../adapter/adapter-waiting.ts";
import { questionStates } from "../items/questions.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { openStore } from "../store/sqlite-store.ts";
import type { Store } from "../store/store.ts";
import { createEngine } from "./engine.ts";

const { dirs, engines, rig, thread } = useCoreEngineFixtures(createEngine);

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

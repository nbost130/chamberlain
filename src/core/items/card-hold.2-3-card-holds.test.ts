/** card-hold, continued: see card-hold.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { AT, approval, open, saw, secretCard } from "../../testing/core-card-hold-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { reconcileRefHolds } from "../decide/hold-reconcile.ts";
import { closeHeldForCard, heldId, heldOpen } from "../ops/afk-held.ts";
import { cardQuestion, cardWaitOf, closeCard, closeCardByHand, holdCard } from "./card-hold.ts";
import { CARD_UNVERIFIED, cardKey, openCards } from "./card-open.ts";
import { reconcileCardHolds, trackUnverified, unverifiedAlarm } from "./card-reconcile.ts";
import { askQuestion, getQuestion, questionStates } from "./questions.ts";

describe("(2)(3) card holds close only on positive evidence: the card's own item in a terminal status, keyed by (server, request ID)", () => {
	test("a hold that recorded no sequence value (written before migration 12), or a pointer question with no hold, is never closed by a read", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		const h = store.items.list({ source: "held" })[0]!;
		const { seq: _q, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({
			source: "held",
			kind: "hold",
			dedupKey: h.dedupKey,
			mode: "silenced",
			payload: old,
			now: Date.now(),
		});
		const r = await reconcileCardHolds(store, saw([], ["req-a1"]));
		expect(r.closed).toEqual([]);
		expect(r.unverified.map((u) => u.reason)).toEqual(["the read did not start after its hold was written"]);
		const q = memStore();
		askQuestion(q, cardQuestion(cardWaitOf(approval, AT), "Q-ptr01", new Date().toISOString()));
		expect((await reconcileCardHolds(q, saw([], ["req-a1"]))).unverified.map((u) => u.reason)).toEqual([
			"it has no open hold, only its pointer question",
		]);
		expect(getQuestion(q, "Q-ptr01")!.status).toBe("open");
	});

	test("unverifiable past the period: an alarm naming the hold, the card and the hand close command; then the operator closes it", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const hold = heldOpen(store)[0]!;
		const H = 3_600_000,
			t0 = Date.parse("2026-11-13T00:00:00.000Z");
		// The card has fallen out of its thread's history window: no evidence either way.
		expect(trackUnverified(store, await reconcileCardHolds(store, saw()), 24 * H, t0)).toEqual([]);
		expect(trackUnverified(store, await reconcileCardHolds(store, saw()), 24 * H, t0 + 23 * H)).toEqual([]);
		const due = trackUnverified(store, await reconcileCardHolds(store, saw()), 24 * H, t0 + 24 * H);
		expect(due).toHaveLength(1);
		const a = unverifiedAlarm(due[0]!, `bun afk.ts close-card main req-a1 "<how it closed>"`);
		expect(a.key).toBe("card-unverified:main:req-a1");
		expect(a.summary).toContain(heldId(hold));
		expect(a.summary).toContain("main request req-a1");
		expect(a.summary).toContain("thread th-1");
		expect(a.summary).toContain(`bun afk.ts close-card main req-a1 "<how it closed>"`);
		expect(a.summary).toContain("Nothing closes it on its own");
		expect(open(store)).toEqual({ holds: 1, questions: 1 });
		expect(getQuestion(store, item)!.status).toBe("open");
		// The operator closes it by hand: hold and question together, and the unverified record ends.
		expect(closeCardByHand(store, { server: "main", requestId: "req-a1" }, "answered in the thread")).toEqual({
			questions: 1,
			holds: 1,
		});
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
		expect(store.items.get(CARD_UNVERIFIED, cardKey({ server: "main", requestId: "req-a1" }))!.status).toBe("resolved");
		expect(() => closeCardByHand(store, { server: "main", requestId: "req-a1" }, "again")).toThrow(
			"no open card hold or question",
		);
	});

	test("a card seen waiting again ends its unverified record, so the period starts over", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		const H = 3_600_000,
			t0 = Date.parse("2026-11-13T00:00:00.000Z");
		const down = async () => ({ ok: false as const, reason: "down" });
		trackUnverified(store, await reconcileCardHolds(store, down), 24 * H, t0);
		trackUnverified(store, await reconcileCardHolds(store, saw(["req-a1"])), 24 * H, t0 + 12 * H);
		expect(trackUnverified(store, await reconcileCardHolds(store, down), 24 * H, t0 + 30 * H)).toEqual([]);
		expect(heldOpen(store)).toHaveLength(1);
	});

	test("an ok: false read, or one that breaks the contract, closes nothing and is reported as failed", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		const r = await reconcileCardHolds(store, async () => ({ ok: false, reason: "main is not connected" }));
		expect(r).toEqual({
			closed: [],
			verified: [],
			unverified: [
				{ card: expect.objectContaining({ server: "main", requestId: "req-a1" }), reason: "main is not connected" },
			],
			failed: [{ server: "main", reason: "main is not connected" }],
		});
		for (const bad of [
			{ state: "read", resolved: new Set(["req-a1"]) },
			{ ok: true, waiting: new Set(), resolved: ["req-a1"] },
			{ ok: true, resolved: new Set(["req-a1"]) },
			{ ok: true, waiting: new Set(), resolved: new Set([3]) },
		]) {
			expect((await reconcileCardHolds(store, async () => bad as never)).closed).toEqual([]);
		}
		expect(heldOpen(store)).toHaveLength(1);
	});

	test("a card whose thread neither its hold nor a question names is listed without one, is never read, and stays open", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const h = store.items.list({ source: "held" })[0]!;
		const { item: _i, card: _c, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({
			source: "held",
			kind: "hold",
			dedupKey: h.dedupKey,
			mode: "silenced",
			payload: { ...old, card: { server: "main", requestId: "req-a1" } },
			now: Date.now(),
		});
		store.items.resolve("queue", item, Date.now());
		expect(openCards(store)).toEqual([{ server: "main", requestId: "req-a1", holds: [{ id: h.dedupKey, seq: 1 }] }]);
		let reads = 0;
		const r = await reconcileCardHolds(store, async () => {
			reads++;
			return { ok: true as const, waiting: new Set<string>(), resolved: new Set(["req-a1"]) };
		});
		expect(reads).toBe(0);
		expect(r.closed).toEqual([]);
		expect(r.unverified.map((u) => u.reason)).toEqual(["neither its hold nor its question names its thread"]);
		expect(heldOpen(store)).toHaveLength(1);
	});

	test("a hold written before `card` existed takes its thread from its pointer question", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		// Rewrite the hold as an older build left it: server and request ID, no card.
		const h = store.items.list({ source: "held" })[0]!;
		const { card: _c, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({
			source: "held",
			kind: "hold",
			dedupKey: h.dedupKey,
			mode: "silenced",
			payload: old,
			now: Date.now(),
		});
		expect(heldOpen(store)[0]!.card).toBeUndefined();
		expect(openCards(store)).toEqual([
			{ server: "main", threadId: "th-1", requestId: "req-a1", holds: [{ id: h.dedupKey, seq: 1 }] },
		]);
		expect((await reconcileCardHolds(store, saw([], ["req-a1"]))).closed).toHaveLength(1);
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
	});

	test("two servers share a request ID: only the one whose card resolved closes, through every path", async () => {
		const store = memStore();
		const a = holdCard(store, cardWaitOf(approval, AT));
		const b = holdCard(store, cardWaitOf(approval, { ...AT, server: "second" }));
		expect(a.item).not.toBe(b.item);
		// "main" shows req-a1 resolved; "second" shows it still waiting.
		const r = await reconcileCardHolds(store, async (server) => ({
			ok: true as const,
			waiting: new Set(server === "second" ? ["req-a1"] : []),
			resolved: new Set(server === "second" ? [] : ["req-a1"]),
		}));
		expect(r.closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(getQuestion(store, b.item)!.status).toBe("open");
		expect(closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({
			questions: 0,
			holds: 0,
		});
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(closeCard(store, { server: "second", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({
			questions: 1,
			holds: 1,
		});
		expect(heldOpen(store)).toEqual([]);
	});
});

describe("(A)(B) one hold per card, and a card hold closes only with its pointer question", () => {
	test("(A) two cards on one thread: two holds, two questions; only the one seen resolved closes", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		holdCard(store, cardWaitOf(secretCard, AT));
		expect(heldOpen(store)).toHaveLength(2);
		expect(questionStates(store).size).toBe(2);
		const r = await reconcileCardHolds(store, async () => ({
			ok: true as const,
			waiting: new Set(["req-s1"]),
			resolved: new Set(["req-a1"]),
		}));
		expect(r.closed.map((c) => c.requestId)).toEqual(["req-a1"]);
		expect(heldOpen(store).map((h) => h.card!.requestId)).toEqual(["req-s1"]);
	});
	test("(B) the ref pass never closes a card hold through its thread, even one that names the thread as a ref", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const h = store.items.list({ source: "held" })[0]!;
		store.items.patch("held", h.dedupKey, { threadId: "th-1", ref: { threadId: "th-1" } });
		const settled = {
			machine: "main",
			healthy: true,
			complete: true,
			get: () => ({ archived: true, settled: true, pendingRequestId: null, status: "idle" }),
		};
		const r = await reconcileRefHolds({ store, snapshots: async () => [settled] });
		expect(r.closed).toBe(0);
		expect(heldOpen(store)).toHaveLength(1);
		expect(getQuestion(store, item)!.status).toBe("open");
	});
	test("(B) a card hold and its question close in one transaction: a failure closing the hold leaves the question open", () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const resolve = store.items.resolve.bind(store.items);
		store.items.resolve = ((source: string, ...rest: unknown[]) => {
			if (source === "held") throw Error("disk full");
			return (resolve as (...a: unknown[]) => unknown)(source, ...rest);
		}) as typeof store.items.resolve;
		expect(() => closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toThrow("disk full");
		store.items.resolve = resolve;
		expect(getQuestion(store, item)!.status).toBe("open");
		expect(heldOpen(store)).toHaveLength(1);
		expect(closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({
			questions: 1,
			holds: 1,
		});
	});
	test("(B) a thread's close (the live path's Steward-hold close) never closes a card hold", () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		expect(closeHeldForCard(store, "main", "th-1", "x")).toBe(0);
		expect(heldOpen(store)).toHaveLength(1);
	});
});

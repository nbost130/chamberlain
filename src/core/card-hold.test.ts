/**
 * (d) The daemon's card holds go behind a question that points to the card: one per card, closed when the card leaves its
 * thread, and nothing of the card's content (a secret's value, its questions, its options) is ever copied.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import { closeHeldForCard, heldId, heldOpen } from "./afk.ts";
import type { WaitingItem } from "./adapter.ts";
import { CARD_UNVERIFIED, cardKey, cardQuestion, cardWaitOf, closeCard, closeCardByHand, closeCardQuestions, holdCard, openCards, questionForCard, reconcileCardHolds, trackUnverified, unverifiedAlarm } from "./card-hold.ts";
import { reconcileItemHolds, reconcileRefHolds } from "./hold-reconcile.ts";
import { askQuestion, getQuestion, isUrgent, questionStates, ranked } from "./questions.ts";
import { findSettled } from "./settled.ts";
import { openStore } from "./sqlite-store.ts";

const AT = { thread: "Deploy pipeline", server: "main", threadId: "th-1" };
const SENTINEL = "plain-SENTINEL-text-never-shown";
const secretCard: WaitingItem = { type: "secret_request", requestId: "req-s1", label: "STRIPE_KEY", questions: [{ question: `paste it: ${SENTINEL}`, options: [{ label: SENTINEL, description: SENTINEL }] }] };
const approval: WaitingItem = { type: "approval_request", requestId: "req-a1", label: "bun run deploy", questions: [{ question: "run it?" }] };

describe("(d) one pointer question per card, and the hold behind it", () => {
	test("a card is filed as an only-you question pointing to it, and held with that item", () => {
		const store = memStore();
		const r = holdCard(store, cardWaitOf(approval, AT));
		expect(r).toMatchObject({ filed: true, held: true });
		const q = getQuestion(store, r.item)!;
		expect(q).toMatchObject({ kind: "only-you", status: "open", cardRequest: "req-a1", server: "main", threadId: "th-1", tag: "Approval", title: "Deploy pipeline waits on your command approval" });
		expect(q.notSettled).toContain("live request");
		expect(heldOpen(store)).toMatchObject([{ item: r.item, requestId: "req-a1", server: "main", what: "command or permission approval: bun run deploy", taken: "left parked" }]);
	});
	test("the same card again files nothing and holds nothing more; another server's card with the same id is its own", () => {
		const store = memStore();
		const first = holdCard(store, cardWaitOf(approval, AT));
		expect(holdCard(store, cardWaitOf(approval, AT))).toEqual({ item: first.item, filed: false, held: false });
		expect(questionStates(store).size).toBe(1);
		expect(heldOpen(store)).toHaveLength(1);
		const other = holdCard(store, cardWaitOf(approval, { ...AT, server: "second" }));
		expect(other.item).not.toBe(first.item);
		expect(heldOpen(store)).toHaveLength(2);
	});
	test("the card leaving its thread closes its question as answered on the card, and the reconciler closes the hold by its item", () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		expect(closeCardQuestions(store, "other", "req-a1")).toBe(0);
		expect(closeCardQuestions(store, "main", "req-a1")).toBe(1);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
		expect(questionForCard(store, "main", "req-a1")).toBeUndefined();
		expect(closeCardQuestions(store, "main", "req-a1")).toBe(0);
		expect(reconcileItemHolds(store)).toEqual({ closed: 1 });
		expect(heldOpen(store)).toEqual([]);
	});
	test("a card's question is never refused as settled, even when an earlier card for the same thing was answered", () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		closeCardQuestions(store, "main", "req-a1");
		const again = cardQuestion(cardWaitOf({ ...approval, requestId: "req-a2" }, AT), "Q-again1", new Date().toISOString());
		expect(findSettled(store, { title: again.title }, {}).matches).not.toEqual([]);
		expect(again.notSettled).toBeTruthy();
		expect(holdCard(store, cardWaitOf({ ...approval, requestId: "req-a2" }, AT))).toMatchObject({ filed: true, held: true });
	});
});

describe("(d) a secret's value is never copied", () => {
	test("only the card's kind, request ID and label travel; the question is itself secret", () => {
		const w = cardWaitOf(secretCard, AT);
		expect(Object.keys(w).sort()).toEqual(["label", "requestId", "server", "thread", "threadId", "type"]);
		const q = cardQuestion(w, "Q-sec001", "2026-11-13T00:00:00.000Z");
		expect(JSON.stringify(q)).not.toContain("SENTINEL");
		expect(q.secret).toBe(true);
		expect(q.context).toContain("The value never goes through this queue.");
	});
	test("nothing written to the database (its file and its log) carries the value", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-card-`);
		const store = openStore(`${dir}/chamberlain.db`);
		holdCard(store, cardWaitOf(secretCard, AT));
		closeCardQuestions(store, "main", "req-s1");
		store.close();
		for (const f of readdirSync(dir)) expect(readFileSync(`${dir}/${f}`).includes(Buffer.from("SENTINEL"))).toBe(false);
	});
});

describe("(1) an approval or a secret is always urgent, on every path that files or reads a question", () => {
	const base = { kind: "only-you" as const, context: "", options: [{ label: "A" }, { label: "B" }], thread: "T", server: "main", createdAt: "2026-11-13T00:00:00.000Z" };
	test("askQuestion drops urgent: false from an approval, a secret and a card pointer, and keeps it on an ordinary question", () => {
		const store = memStore();
		askQuestion(store, { ...base, id: "Q-apr001", title: "a", tag: "approval", urgent: false });
		askQuestion(store, { ...base, id: "Q-sec001", title: "s", secret: true, urgent: false });
		askQuestion(store, { ...base, id: "Q-stg001", title: "s2", tag: "Secret", urgent: false });
		askQuestion(store, { ...cardQuestion(cardWaitOf(approval, AT), "Q-ptr001", base.createdAt), urgent: false });
		askQuestion(store, { ...base, id: "Q-plain1", title: "p", urgent: false });
		for (const id of ["Q-apr001", "Q-sec001", "Q-stg001", "Q-ptr001"]) {
			expect(store.items.get("queue", id)!.payload.urgent).toBeUndefined();
			expect(getQuestion(store, id)!.urgent).toBeUndefined();
		}
		expect(getQuestion(store, "Q-plain1")!.urgent).toBe(false);
	});
	test("a row written around askQuestion (an older build) still reads back urgent, and ranks above every non-urgent one", () => {
		const store = memStore();
		const raw = (id: string, over: object) => store.items.observe({ source: "queue", kind: "question", dedupKey: id, mode: "silenced", payload: { ...base, id, title: id, urgent: false, ...over }, now: Date.now() });
		raw("Q-plain2", {});
		raw("Q-apr002", { tag: "Approval" });
		raw("Q-sec002", { secret: true });
		raw("Q-ptr002", { cardRequest: "req-9" });
		expect(isUrgent(getQuestion(store, "Q-apr002")!) && isUrgent(getQuestion(store, "Q-sec002")!) && isUrgent(getQuestion(store, "Q-ptr002")!)).toBe(true);
		expect(ranked(questionStates(store).values()).at(-1)!.id).toBe("Q-plain2");
	});
	test("a daemon's card pointer, approval or secret, is filed urgent", () => {
		const store = memStore();
		for (const card of [approval, secretCard]) {
			const r = holdCard(store, cardWaitOf(card, AT));
			expect(isUrgent(getQuestion(store, r.item)!)).toBe(true);
			expect(r.question!.urgent).toBeUndefined();
		}
	});
});

describe("(2)(3) card holds close only on positive evidence: the card's own item in a terminal status, keyed by (server, request ID)", () => {
	const fileStore = () => { const dir = mkdtempSync(`${tmpdir()}/chamberlain-cardrec-`); return { path: `${dir}/chamberlain.db`, open: () => openStore(`${dir}/chamberlain.db`) }; };
	/** A read that saw these request IDs waiting and these resolved. */
	const saw = (waiting: string[] = [], resolved: string[] = []) => async () => ({ ok: true as const, waiting: new Set(waiting), resolved: new Set(resolved) });
	const open = (store: ReturnType<typeof memStore>) => ({ holds: heldOpen(store).length, questions: [...questionStates(store).values()].filter((q) => q.status === "open").length });
	test("the hold carries what closing needs: server, thread and request ID", () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		expect(heldOpen(store)[0]!.card).toEqual({ server: "main", threadId: "th-1", requestId: "req-a1" });
	});
	test("restart: a card resolved while the daemon was down closes its question and hold on the first pass, exactly once", async () => {
		const db = fileStore();
		const before = db.open();
		const { item } = holdCard(before, cardWaitOf(approval, AT));
		before.close();
		// A fresh process: nothing in memory, only the database.
		const after = db.open();
		const reads: string[] = [];
		const read = async (server: string, threadId: string) => { reads.push(`${server}/${threadId}`); return { ok: true as const, waiting: new Set<string>(), resolved: new Set(["req-a1"]) }; };
		expect((await reconcileCardHolds(after, read)).closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(reads).toEqual(["main/th-1"]);
		expect(getQuestion(after, item)!.status).toBe("answered-on-card");
		expect(heldOpen(after)).toEqual([]);
		expect((await reconcileCardHolds(after, read)).closed).toEqual([]);
		after.close();
	});
	test("absence closes nothing: a read that does not show the card (a bounded window), or shows only other cards, leaves it open", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		for (const read of [saw(), saw(["req-other"]), saw([], ["req-other"])]) {
			const r = await reconcileCardHolds(store, read);
			expect(r.closed).toEqual([]);
			expect(r.unverified.map((u) => u.reason)).toEqual([expect.stringContaining("history window")]);
		}
		expect(open(store)).toEqual({ holds: 1, questions: 1 });
		expect(getQuestion(store, item)!.status).toBe("open");
	});
	test("a card seen still waiting stays open and is verified; seen resolved it closes exactly once, hold and question together", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const r = await reconcileCardHolds(store, saw(["req-a1"]));
		expect(r.closed).toEqual([]);
		expect(r.verified.map((c) => c.requestId)).toEqual(["req-a1"]);
		expect((await reconcileCardHolds(store, saw([], ["req-a1"]))).closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect((await reconcileCardHolds(store, saw([], ["req-a1"]))).closed).toEqual([]);
		expect(store.items.list({ source: "held" }).filter((i) => i.status === "resolved")).toHaveLength(1);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
	});
	test("restart: a card whose read fails stays open; there is no 'thread gone' close", async () => {
		const db = fileStore();
		const s = db.open();
		holdCard(s, cardWaitOf({ ...approval, requestId: "req-a2" }, { ...AT, threadId: "th-down" }));
		holdCard(s, cardWaitOf({ ...approval, requestId: "req-a3" }, { ...AT, threadId: "th-live" }));
		s.close();
		const after = db.open();
		const r = await reconcileCardHolds(after, async (_s, t) => (t === "th-down" ? { ok: false as const, reason: "thread not found" } : { ok: true as const, waiting: new Set(["req-a3"]), resolved: new Set<string>() }));
		expect(r.closed).toEqual([]);
		expect(r.unverified.map((u) => [u.card.requestId, u.reason])).toEqual([["req-a2", "thread not found"]]);
		expect(r.verified.map((c) => c.requestId)).toEqual(["req-a3"]);
		expect(heldOpen(after).map((h) => h.card!.requestId).sort()).toEqual(["req-a2", "req-a3"]);
		expect((await reconcileCardHolds(after, async () => { throw Error("socket down"); })).closed).toEqual([]);
		expect(heldOpen(after)).toHaveLength(2);
		after.close();
	});
	test("clock rollback: a hold written while the clock read 2099 closes on a later read at 2000; order is the store sequence, not the clock", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT), new Date("2099-01-01T00:00:00.000Z"));
		const seq = heldOpen(store)[0]!.seq!;
		expect(seq).toBe(store.sequence.current());
		expect((await reconcileCardHolds(store, saw([], ["req-a1"]), () => new Date("2000-01-01T00:00:00.000Z"))).closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
		expect(store.sequence.current()).toBe(seq + 1);
	});
	test("the read must start after the hold: a hold written while the read is out stays open, with its question; the next read closes it", async () => {
		const store = memStore();
		const first = holdCard(store, cardWaitOf(approval, AT));
		// While the read of th-1 is out, the first card's hold is replaced (closed by hand, then held again) and a second card is held.
		let late = "";
		const r = await reconcileCardHolds(store, async () => {
			closeCardByHand(store, "main", "req-a1", "test: replaced");
			late = holdCard(store, cardWaitOf(approval, AT)).item;
			holdCard(store, cardWaitOf({ ...approval, requestId: "req-b" }, AT));
			return { ok: true as const, waiting: new Set<string>(), resolved: new Set(["req-a1", "req-b"]) };
		});
		expect(r.closed).toEqual([]);
		expect(heldOpen(store).map((h) => h.card!.requestId).sort()).toEqual(["req-a1", "req-b"]);
		expect(getQuestion(store, first.item)!.status).toBe("answered-on-card");
		expect(getQuestion(store, late)!.status).toBe("open");
		// The next read started after both holds: they close.
		expect((await reconcileCardHolds(store, saw([], ["req-a1", "req-b"]))).closed.map((c) => c.requestId).sort()).toEqual(["req-a1", "req-b"]);
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, late)!.status).toBe("answered-on-card");
	});
	test("a hold that recorded no sequence value (written before migration 12), or a pointer question with no hold, is never closed by a read", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		const h = store.items.list({ source: "held" })[0]!;
		const { seq: _q, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({ source: "held", kind: "hold", dedupKey: h.dedupKey, mode: "silenced", payload: old, now: Date.now() });
		const r = await reconcileCardHolds(store, saw([], ["req-a1"]));
		expect(r.closed).toEqual([]);
		expect(r.unverified.map((u) => u.reason)).toEqual(["the read did not start after its hold was written"]);
		const q = memStore();
		askQuestion(q, cardQuestion(cardWaitOf(approval, AT), "Q-ptr01", new Date().toISOString()));
		expect((await reconcileCardHolds(q, saw([], ["req-a1"]))).unverified.map((u) => u.reason)).toEqual(["it has no open hold, only its pointer question"]);
		expect(getQuestion(q, "Q-ptr01")!.status).toBe("open");
	});
	test("unverifiable past the period: an alarm naming the hold, the card and the hand close command; then the operator closes it", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const hold = heldOpen(store)[0]!;
		const H = 3_600_000, t0 = Date.parse("2026-11-13T00:00:00.000Z");
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
		expect(closeCardByHand(store, "main", "req-a1", "answered in the thread")).toEqual({ questions: 1, holds: 1 });
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
		expect(store.items.get(CARD_UNVERIFIED, cardKey({ server: "main", requestId: "req-a1" }))!.status).toBe("resolved");
		expect(() => closeCardByHand(store, "main", "req-a1", "again")).toThrow("no open card hold or question");
	});
	test("a card seen waiting again ends its unverified record, so the period starts over", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		const H = 3_600_000, t0 = Date.parse("2026-11-13T00:00:00.000Z");
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
		expect(r).toEqual({ closed: [], verified: [], unverified: [{ card: expect.objectContaining({ server: "main", requestId: "req-a1" }), reason: "main is not connected" }], failed: [{ server: "main", reason: "main is not connected" }] });
		for (const bad of [{ state: "read", resolved: new Set(["req-a1"]) }, { ok: true, waiting: new Set(), resolved: ["req-a1"] }, { ok: true, resolved: new Set(["req-a1"]) }, { ok: true, waiting: new Set(), resolved: new Set([3]) }]) {
			expect((await reconcileCardHolds(store, async () => bad as never)).closed).toEqual([]);
		}
		expect(heldOpen(store)).toHaveLength(1);
	});
	test("a hold written before `card` existed takes its thread from its pointer question", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		// Rewrite the hold as an older build left it: server and request ID, no card.
		const h = store.items.list({ source: "held" })[0]!;
		const { card: _c, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({ source: "held", kind: "hold", dedupKey: h.dedupKey, mode: "silenced", payload: old, now: Date.now() });
		expect(heldOpen(store)[0]!.card).toBeUndefined();
		expect(openCards(store)).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1", holds: [{ id: h.dedupKey, seq: 1 }] }]);
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
		const r = await reconcileCardHolds(store, async (server) => ({ ok: true as const, waiting: new Set(server === "second" ? ["req-a1"] : []), resolved: new Set(server === "second" ? [] : ["req-a1"]) }));
		expect(r.closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(getQuestion(store, b.item)!.status).toBe("open");
		expect(closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({ questions: 0, holds: 0 });
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(closeCard(store, { server: "second", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({ questions: 1, holds: 1 });
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
		const r = await reconcileCardHolds(store, async () => ({ ok: true as const, waiting: new Set(["req-s1"]), resolved: new Set(["req-a1"]) }));
		expect(r.closed.map((c) => c.requestId)).toEqual(["req-a1"]);
		expect(heldOpen(store).map((h) => h.card!.requestId)).toEqual(["req-s1"]);
	});
	test("(B) the ref pass never closes a card hold through its thread, even one that names the thread as a ref", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const h = store.items.list({ source: "held" })[0]!;
		store.items.patch("held", h.dedupKey, { threadId: "th-1", ref: { threadId: "th-1" } });
		const settled = { machine: "main", healthy: true, complete: true, get: () => ({ archived: true, settled: true, pendingRequestId: null, status: "idle" }) };
		const r = await reconcileRefHolds({ store, snapshots: async () => [settled] });
		expect(r.closed).toBe(0);
		expect(heldOpen(store)).toHaveLength(1);
		expect(getQuestion(store, item)!.status).toBe("open");
	});
	test("(B) a card hold and its question close in one transaction: a failure closing the hold leaves the question open", () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		const resolve = store.items.resolve.bind(store.items);
		store.items.resolve = ((source: string, ...rest: unknown[]) => { if (source === "held") throw Error("disk full"); return (resolve as (...a: unknown[]) => unknown)(source, ...rest); }) as typeof store.items.resolve;
		expect(() => closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toThrow("disk full");
		store.items.resolve = resolve;
		expect(getQuestion(store, item)!.status).toBe("open");
		expect(heldOpen(store)).toHaveLength(1);
		expect(closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({ questions: 1, holds: 1 });
	});
	test("(B) a thread's close (the live path's Steward-hold close) never closes a card hold", () => {
		const store = memStore();
		holdCard(store, cardWaitOf(approval, AT));
		expect(closeHeldForCard(store, "main", "th-1", "x")).toBe(0);
		expect(heldOpen(store)).toHaveLength(1);
	});
});

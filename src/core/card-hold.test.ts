/**
 * (d) The daemon's card holds go behind a question that points to the card: one per card, closed when the card leaves its
 * thread, and nothing of the card's content (a secret's value, its questions, its options) is ever copied.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import { heldOpen } from "./afk.ts";
import type { WaitingItem } from "./adapter.ts";
import { cardQuestion, cardWaitOf, closeCard, closeCardQuestions, holdCard, openCards, questionForCard, reconcileCardHolds } from "./card-hold.ts";
import { reconcileItemHolds } from "./hold-reconcile.ts";
import { askQuestion, getQuestion, isUrgent, questionStates, ranked } from "./questions.ts";
import { findSettled } from "./settled.ts";
import { openStore } from "./sqlite-store.ts";

const AT = { thread: "Deploy pipeline", server: "main", threadId: "th-1" };
const SECRET = "plain-SENTINEL-not-a-key";
const secretCard: WaitingItem = { type: "secret_request", requestId: "req-s1", label: "STRIPE_KEY", questions: [{ question: `paste it: ${SECRET}`, options: [{ label: SECRET, description: SECRET }] }] };
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

describe("(2)(3) card holds reconcile against the cards actually waiting, keyed by (server, request ID)", () => {
	const fileStore = () => { const dir = mkdtempSync(`${tmpdir()}/chamberlain-cardrec-`); return { path: `${dir}/chamberlain.db`, open: () => openStore(`${dir}/chamberlain.db`) }; };
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
		const read = async (server: string, threadId: string) => { reads.push(`${server}/${threadId}`); return { state: "read" as const, waiting: new Set<string>() }; };
		expect((await reconcileCardHolds(after, read)).closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(reads).toEqual(["main/th-1"]);
		expect(getQuestion(after, item)!.status).toBe("answered-on-card");
		expect(heldOpen(after)).toEqual([]);
		expect(await reconcileCardHolds(after, read)).toEqual({ closed: [], unknown: 0 });
		after.close();
	});
	test("restart: a card whose thread disappeared closes; one that cannot be read, or still waits, stays open", async () => {
		const db = fileStore();
		const s = db.open();
		holdCard(s, cardWaitOf(approval, { ...AT, threadId: "th-gone" }));
		holdCard(s, cardWaitOf({ ...approval, requestId: "req-a2" }, { ...AT, threadId: "th-down" }));
		holdCard(s, cardWaitOf({ ...approval, requestId: "req-a3" }, { ...AT, threadId: "th-live" }));
		s.close();
		const after = db.open();
		const r = await reconcileCardHolds(after, async (_s, t) => (t === "th-gone" ? { state: "gone" } : t === "th-down" ? { state: "unknown" } : { state: "read", waiting: new Set(["req-a3"]) }));
		expect(r.closed.map((c) => c.threadId)).toEqual(["th-gone"]);
		expect(r.unknown).toBe(1);
		expect(heldOpen(after).map((h) => h.card!.requestId).sort()).toEqual(["req-a2", "req-a3"]);
		// A read that throws is unknown too, never "gone".
		expect((await reconcileCardHolds(after, async () => { throw Error("socket down"); })).closed).toEqual([]);
		expect(heldOpen(after)).toHaveLength(2);
		after.close();
	});
	test("a hold written before `card` existed takes its thread from its pointer question", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT));
		// Rewrite the hold as an older build left it: server and request ID, no card.
		const h = store.items.list({ source: "held" })[0]!;
		const { card: _c, ...old } = h.payload as Record<string, unknown>;
		store.items.observe({ source: "held", kind: "hold", dedupKey: h.dedupKey, mode: "silenced", payload: old, now: Date.now() });
		expect(heldOpen(store)[0]!.card).toBeUndefined();
		expect(openCards(store)).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect((await reconcileCardHolds(store, async () => ({ state: "read", waiting: new Set() }))).closed).toHaveLength(1);
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
	});
	test("two servers share a request ID: only the one whose card resolved closes, through every path", async () => {
		const store = memStore();
		const a = holdCard(store, cardWaitOf(approval, AT));
		const b = holdCard(store, cardWaitOf(approval, { ...AT, server: "second" }));
		expect(a.item).not.toBe(b.item);
		// Reconcile: "main" no longer waits on req-a1, "second" still does.
		const r = await reconcileCardHolds(store, async (server) => ({ state: "read", waiting: new Set(server === "second" ? ["req-a1"] : []) }));
		expect(r.closed).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(getQuestion(store, b.item)!.status).toBe("open");
		// Direct close (the engine's fast path) on "main" again touches nothing on "second".
		expect(closeCard(store, { server: "main", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({ questions: 0, holds: 0 });
		expect(heldOpen(store).map((h) => h.server)).toEqual(["second"]);
		expect(closeCard(store, { server: "second", threadId: "th-1", requestId: "req-a1" }, "x")).toEqual({ questions: 1, holds: 1 });
		expect(heldOpen(store)).toEqual([]);
	});
});

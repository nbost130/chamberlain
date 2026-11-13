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
import { cardQuestion, cardWaitOf, closeCardQuestions, holdCard, questionForCard } from "./card-hold.ts";
import { reconcileItemHolds } from "./hold-reconcile.ts";
import { getQuestion, questionStates } from "./questions.ts";
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

/**
 * (d) The daemon's card holds go behind a question that points to the card: one per card, closed when the card leaves its
 * thread, and nothing of the card's content (a secret's value, its questions, its options) is ever copied.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AT, approval, fileStore, open, saw, secretCard } from "../../testing/core-card-hold-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { reconcileItemHolds } from "../decide/hold-reconcile.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { openStore } from "../store/sqlite-store.ts";
import {
	cardQuestion,
	cardWaitOf,
	closeCardByHand,
	closeCardQuestions,
	holdCard,
	questionForCard,
} from "./card-hold.ts";
import { reconcileCardHolds } from "./card-reconcile.ts";
import { askQuestion, getQuestion, isUrgent, questionStates } from "./questions.ts";
import { ranked } from "./questions-wake.ts";
import { findSettled } from "./settled.ts";

describe("(d) one pointer question per card, and the hold behind it", () => {
	test("a card is filed as an only-you question pointing to it, and held with that item", () => {
		const store = memStore();
		const r = holdCard(store, cardWaitOf(approval, AT));
		expect(r).toMatchObject({ filed: true, held: true });
		const q = getQuestion(store, r.item)!;
		expect(q).toMatchObject({
			kind: "only-you",
			status: "open",
			cardRequest: "req-a1",
			server: "main",
			threadId: "th-1",
			tag: "Approval",
			title: "Deploy pipeline waits on your command approval",
		});
		expect(q.notSettled).toContain("live request");
		expect(heldOpen(store)).toMatchObject([
			{
				item: r.item,
				requestId: "req-a1",
				server: "main",
				what: "command or permission approval: bun run deploy",
				taken: "left parked",
			},
		]);
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
		const again = cardQuestion(
			cardWaitOf({ ...approval, requestId: "req-a2" }, AT),
			"Q-again1",
			new Date().toISOString(),
		);
		expect(findSettled(store, { title: again.title }, {}).matches).not.toEqual([]);
		expect(again.notSettled).toBeTruthy();
		expect(holdCard(store, cardWaitOf({ ...approval, requestId: "req-a2" }, AT))).toMatchObject({
			filed: true,
			held: true,
		});
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
		// #102: the card label never enters the pointer's context or the hold's what.
		expect(q.context).not.toContain(w.label);
		const store = memStore();
		holdCard(store, w);
		expect(heldOpen(store).map((h) => h.what)).toEqual(["secret request"]);
		expect(JSON.stringify(heldOpen(store))).not.toContain(w.label);
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
	const base = {
		kind: "only-you" as const,
		context: "",
		options: [{ label: "A" }, { label: "B" }],
		thread: "T",
		server: "main",
		createdAt: "2026-11-13T00:00:00.000Z",
	};
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
		const raw = (id: string, over: object) =>
			store.items.observe({
				source: "queue",
				kind: "question",
				dedupKey: id,
				mode: "silenced",
				payload: { ...base, id, title: id, urgent: false, ...over },
				now: Date.now(),
			});
		raw("Q-plain2", {});
		raw("Q-apr002", { tag: "Approval" });
		raw("Q-sec002", { secret: true });
		raw("Q-ptr002", { cardRequest: "req-9" });
		expect(
			isUrgent(getQuestion(store, "Q-apr002")!) &&
				isUrgent(getQuestion(store, "Q-sec002")!) &&
				isUrgent(getQuestion(store, "Q-ptr002")!),
		).toBe(true);
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
		const read = async (server: string, threadId: string) => {
			reads.push(`${server}/${threadId}`);
			return { ok: true as const, waiting: new Set<string>(), resolved: new Set(["req-a1"]) };
		};
		expect((await reconcileCardHolds(after, read)).closed).toEqual([
			{ server: "main", threadId: "th-1", requestId: "req-a1" },
		]);
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
		expect((await reconcileCardHolds(store, saw([], ["req-a1"]))).closed).toEqual([
			{ server: "main", threadId: "th-1", requestId: "req-a1" },
		]);
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
		const r = await reconcileCardHolds(after, async (_s, t) =>
			t === "th-down"
				? { ok: false as const, reason: "thread not found" }
				: { ok: true as const, waiting: new Set(["req-a3"]), resolved: new Set<string>() },
		);
		expect(r.closed).toEqual([]);
		expect(r.unverified.map((u) => [u.card.requestId, u.reason])).toEqual([["req-a2", "thread not found"]]);
		expect(r.verified.map((c) => c.requestId)).toEqual(["req-a3"]);
		expect(
			heldOpen(after)
				.map((h) => h.card!.requestId)
				.sort(),
		).toEqual(["req-a2", "req-a3"]);
		expect(
			(
				await reconcileCardHolds(after, async () => {
					throw Error("socket down");
				})
			).closed,
		).toEqual([]);
		expect(heldOpen(after)).toHaveLength(2);
		after.close();
	});

	test("clock rollback: a hold written while the clock read 2099 closes on a later read at 2000; order is the store sequence, not the clock", async () => {
		const store = memStore();
		const { item } = holdCard(store, cardWaitOf(approval, AT), new Date("2099-01-01T00:00:00.000Z"));
		const seq = heldOpen(store)[0]!.seq!;
		expect(seq).toBe(store.sequence.current());
		expect(
			(await reconcileCardHolds(store, saw([], ["req-a1"]), () => new Date("2000-01-01T00:00:00.000Z"))).closed,
		).toEqual([{ server: "main", threadId: "th-1", requestId: "req-a1" }]);
		expect(getQuestion(store, item)!.status).toBe("answered-on-card");
		expect(store.sequence.current()).toBe(seq + 1);
	});

	test("the read must start after the hold: a hold written while the read is out stays open, with its question; the next read closes it", async () => {
		const store = memStore();
		const first = holdCard(store, cardWaitOf(approval, AT));
		// While the read of th-1 is out, the first card's hold is replaced (closed by hand, then held again) and a second card is held.
		let late = "";
		const r = await reconcileCardHolds(store, async () => {
			closeCardByHand(store, { server: "main", requestId: "req-a1" }, "test: replaced");
			late = holdCard(store, cardWaitOf(approval, AT)).item;
			holdCard(store, cardWaitOf({ ...approval, requestId: "req-b" }, AT));
			return { ok: true as const, waiting: new Set<string>(), resolved: new Set(["req-a1", "req-b"]) };
		});
		expect(r.closed).toEqual([]);
		expect(
			heldOpen(store)
				.map((h) => h.card!.requestId)
				.sort(),
		).toEqual(["req-a1", "req-b"]);
		expect(getQuestion(store, first.item)!.status).toBe("answered-on-card");
		expect(getQuestion(store, late)!.status).toBe("open");
		// The next read started after both holds: they close.
		expect(
			(await reconcileCardHolds(store, saw([], ["req-a1", "req-b"]))).closed.map((c) => c.requestId).sort(),
		).toEqual(["req-a1", "req-b"]);
		expect(heldOpen(store)).toEqual([]);
		expect(getQuestion(store, late)!.status).toBe("answered-on-card");
	});
});

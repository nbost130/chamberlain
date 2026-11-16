/**
 * Per-option routing of a queue answer: a thread-routed option picked with no note goes straight to the item's thread,
 * once; everything else, and a failed send, wakes the Steward with the reason.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type Answer, getQuestion } from "../core/items/questions.ts";
import { claimWake, pageClaim, readRelay, startRelay } from "../core/items/questions-claim.ts";
import { answerRoute } from "../core/items/questions-wake.ts";
import { appendHeld, heldOpen } from "../core/ops/afk-held.ts";
import { dbPath } from "../core/store/store.ts";
import { fetchWake } from "../testing/wake.ts";
import { useWebRouteFixtures } from "../testing/web-route-fixtures.ts";

const { routed, setup, relays } = useWebRouteFixtures(fetchWake);

describe("a thread-routed option picked with no note", () => {
	test("goes straight to its thread as one message, and the Steward gets only the ledger and log lines", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		const r = await s.answer("Q-abcd", { choice: 0 });
		expect(r.status).toBe(200);
		expect((await r.json()).to).toBe("thread");
		expect(s.posts).toHaveLength(0);
		expect(s.sends).toHaveLength(1);
		const sent = s.sends[0]!;
		expect(sent.server).toBe("main");
		expect(sent.threadId).toBe("thread-1");
		expect(sent.text.startsWith("Steward")).toBe(true);
		expect(sent.text).toContain("decision queue");
		expect(sent.text).toContain("Q-abcd");
		expect(sent.text).toContain("Their choice: Ship the blue one");
		expect(sent.text).toContain("What to do: Use the blue palette and open the PR.");
		expect(sent.text).not.toContain("His note");
		expect(relays(s)).toEqual([expect.objectContaining({ item: "Q-abcd", outcome: "delivered" })]);
		expect(s.logs.filter((l) => l.event === "relayed-to-thread")).toEqual([
			{
				event: "relayed-to-thread",
				data: expect.objectContaining({
					item: "Q-abcd",
					choice: "Ship the blue one",
					threadId: "thread-1",
					outcome: "delivered",
				}),
			},
		]);
		const st = getQuestion(s.store, "Q-abcd")!;
		expect(st.delivered).toBe(true);
		expect(st.relay?.outcome).toBe("delivered");
	});

	test("a repeat answer, a heartbeat and a restart never send it again or wake the Steward", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 0 });
		expect((await s.answer("Q-abcd", { choice: 0 })).status).toBe(409);
		expect((await s.answer("Q-abcd", { choice: 1 })).status).toBe(409);
		await s.tick();
		await s.tick();
		const again = setup({ root: s.root });
		await again.tick();
		expect(s.sends).toHaveLength(1);
		expect(again.sends).toHaveLength(0);
		expect(s.posts).toHaveLength(0);
		expect(again.posts).toHaveLength(0);
		expect(relays(s)).toHaveLength(1);
	});
});

describe("a failed direct send falls back to the Steward", () => {
	test("a refused send wakes the Steward once, saying the direct send failed and why", async () => {
		const s = setup({ send: () => ({ ok: false, detail: "rpc failure: no such thread" }) });
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 0 });
		expect(s.sends).toHaveLength(1);
		expect(s.posts).toHaveLength(1);
		const w = s.posts[0]!;
		expect(w.deliveryId).toBe("answer:item:Q-abcd");
		expect(w.message.startsWith("[chamberlain] answer: ")).toBe(true);
		expect(w.message).toContain("choice: 1. Ship the blue one");
		expect(w.message).toContain("route: to you, not straight to the thread (direct send failed)");
		expect(w.message).toContain("relay text for this option: Use the blue palette and open the PR.");
		expect(w.message).toContain("send error: rpc failure: no such thread");
		expect(relays(s)).toEqual([expect.objectContaining({ item: "Q-abcd", outcome: "failed" })]);
		// Later heartbeats neither retry the thread nor wake the Steward again.
		await s.tick();
		await s.tick();
		expect(s.sends).toHaveLength(1);
		expect(s.posts).toHaveLength(1);
		expect(getQuestion(s.store, "Q-abcd")!.delivered).toBe(true);
	});

	test("a sender that throws, or no sender at all, falls back the same way", async () => {
		const thrown = setup({ send: () => Error("socket closed") });
		thrown.add(routed("Q-abcd"));
		await thrown.answer("Q-abcd", { choice: 0 });
		expect(thrown.posts).toHaveLength(1);
		expect(thrown.posts[0]!.message).toContain("send error: Error: socket closed");
		const none = setup({ noSender: true });
		none.add(routed("Q-efgh"));
		await none.answer("Q-efgh", { choice: 0 });
		expect(none.posts).toHaveLength(1);
		expect(none.posts[0]!.message).toContain("(direct send failed)");
	});

	test("a send cut short by a crash is never sent again: recovery wakes the Steward saying it may have reached the thread", async () => {
		const s = setup();
		const i = routed("Q-abcd");
		s.add(i);
		// The process died after taking the send and before recording how it ended.
		const a: Answer = {
			choice: 0,
			label: "Ship the blue one",
			by: "page",
			t: new Date().toISOString(),
			deliveryId: "answer:item:Q-abcd",
		};
		expect(claimWake(s.store, pageClaim(i, a)).won).toBe(true);
		expect(startRelay(s.store, "Q-abcd")).toBe(true);
		const fresh = setup({ root: s.root });
		await fresh.tick();
		expect(fresh.sends).toHaveLength(0);
		expect(fresh.posts).toHaveLength(1);
		expect(fresh.posts[0]!.message).toContain("may or may not have reached the thread");
		expect(fresh.posts[0]!.message).toContain("check the thread before re-sending");
		expect(fresh.posts[0]!.message).not.toContain("relay it yourself");
		expect(readRelay(fresh.store, "Q-abcd")).toEqual(expect.objectContaining({ started: true, outcome: "failed" }));
		await fresh.tick();
		expect(fresh.posts).toHaveLength(1);
	});
});

describe("answers routed straight to the thread", () => {
	test("when the send can't be taken (the relays table refuses the row), the Steward's answer wake still goes, saying the direct send failed", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		// A database that refuses the relays row (as a full disk would): taking the direct send throws.
		const raw = new Database(dbPath(s.state));
		raw.run(
			"CREATE TRIGGER refuse_relays BEFORE INSERT ON relays BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
		);
		raw.close();
		expect((await s.answer("Q-abcd", { choice: 0 })).status).toBe(200);
		expect(s.sends).toHaveLength(0);
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.deliveryId).toBe("answer:item:Q-abcd");
		expect(s.posts[0]!.message).toContain("(direct send failed)");
		expect(s.posts[0]!.message).toContain("relay it yourself");
		expect(s.posts[0]!.message).toContain("send error: the direct send could not start");
		expect(getQuestion(s.store, "Q-abcd")!.delivered).toBe(true);
		// Heartbeats after it neither throw nor wake again.
		await s.tick();
		expect(s.posts).toHaveLength(1);
	});

	test("a direct delivery closes the item's hold by its item field only; an ID named in the text closes nothing", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		appendHeld(s.store, { thread: "Mobile app", what: "palette pick", taken: "kept working on tests", item: "Q-abcd" });
		appendHeld(s.store, { thread: "Mobile app", what: "palette pick, queue item Q-abcd", taken: "none" });
		appendHeld(s.store, { thread: "Mobile app", what: "deploy approval, queue item Q-abcde" });
		await s.answer("Q-abcd", { choice: 0 });
		expect(s.sends).toHaveLength(1);
		expect(heldOpen(s.store).map((h) => h.what)).toEqual([
			"palette pick, queue item Q-abcd",
			"deploy approval, queue item Q-abcde",
		]);
		expect(s.logs.find((l) => l.event === "held-closed-for-item")?.data).toEqual({ item: "Q-abcd", closed: 1 });
	});

	test("a failed relay leaves the hold open for the Steward to close on its wake", async () => {
		const s = setup({ send: () => ({ ok: false, detail: "rpc failure: no such thread" }) });
		s.add(routed("Q-abcd"));
		appendHeld(s.store, { thread: "Mobile app", what: "palette pick", item: "Q-abcd" });
		await s.answer("Q-abcd", { choice: 0 });
		await s.tick();
		expect(s.posts).toHaveLength(1);
		expect(heldOpen(s.store).map((h) => h.item)).toEqual(["Q-abcd"]);
	});

	test("a send that timed out may have delivered, so the wake says check the thread before re-sending", async () => {
		const s = setup({ send: () => Error("send timed out after 10000 ms") });
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 0 });
		expect(s.posts).toHaveLength(1);
		const m = s.posts[0]!.message;
		expect(m).toContain("may or may not have reached the thread");
		expect(m).toContain("check the thread before re-sending");
		expect(m).not.toContain("relay it yourself");
		expect(m).toContain("send error: Error: send timed out after 10000 ms");
		// The same from a sender that reports the timeout rather than throwing it.
		const r = setup({ send: () => ({ ok: false, detail: "send timed out after 10000 ms" }) });
		r.add(routed("Q-efgh"));
		await r.answer("Q-efgh", { choice: 0 });
		expect(r.posts[0]!.message).toContain("may or may not have reached the thread");
	});

	test("a plain failure keeps 'relay it yourself'", async () => {
		const s = setup({ send: () => Error("connect refused") });
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 0 });
		expect(s.posts[0]!.message).toContain("relay it yourself");
		expect(s.posts[0]!.message).not.toContain("may or may not have reached");
	});
});

describe("answers that stay with the Steward", () => {
	test("a thread-routed option with a note wakes the Steward and sends nothing to the thread", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 0, note: "but keep the old logo" });
		expect(s.sends).toHaveLength(0);
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.message).toContain("note: but keep the old logo");
		expect(s.posts[0]!.message).toContain("route: to you, not straight to the thread (note present)");
		expect(s.posts[0]!.message).toContain("relay text for this option: Use the blue palette and open the PR.");
		expect(relays(s)).toHaveLength(0);
	});

	test("a steward-routed option wakes the Steward, saying so", async () => {
		const s = setup();
		s.add(routed("Q-abcd"));
		await s.answer("Q-abcd", { choice: 1 });
		expect(s.sends).toHaveLength(0);
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.message).toContain("choice: 2. Hold");
		expect(s.posts[0]!.message).toContain("(steward option)");
		expect(s.posts[0]!.message).not.toContain("relay text");
	});

	test("an item with no thread-routed option gives today's wake, word for word", async () => {
		const s = setup();
		const plain = routed("Q-abcd", { options: [{ label: "A · One" }, { label: "B · Two" }] });
		s.add(plain);
		await s.answer("Q-abcd", { choice: 0 });
		expect(s.sends).toHaveLength(0);
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.message).not.toContain("route:");
		expect(s.posts[0]!.message).toContain("choice: 1. A · One");
	});

	test("a custom answer, one that is not the option's own label, is the Steward's", () => {
		const i = routed("Q-abcd");
		const a = (over: Partial<Answer>): Answer => ({
			choice: 0,
			label: "Ship the blue one",
			by: "page",
			t: "x",
			deliveryId: "answer:item:Q-abcd",
			...over,
		});
		expect(answerRoute(i, a({}))).toEqual({
			direct: true,
			server: "main",
			threadId: "thread-1",
			relay: "Use the blue palette and open the PR.",
		});
		expect(answerRoute(i, a({ label: "Other: make it teal" }))).toEqual({ direct: false, why: "custom answer" });
		expect(answerRoute(i, a({ choice: 7, label: "Something else" }))).toEqual({ direct: false, why: "custom answer" });
		expect(answerRoute(i, a({ note: "teal" }))).toEqual({ direct: false, why: "note present" });
		expect(answerRoute(i, a({ choice: 1, label: "Hold" }))).toEqual({ direct: false, why: "steward option" });
		expect(answerRoute(i, a({ ruling: { id: "R9", decides: "blue" } }))).toEqual({
			direct: false,
			why: "ruling saved",
		});
		const c = pageClaim(i, a({ label: "Other: make it teal" }));
		expect(c.relay).toBeUndefined();
		expect(c.message).toContain("(custom answer)");
	});
});

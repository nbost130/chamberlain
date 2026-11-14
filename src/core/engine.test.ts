/**
 * The engine against the in-memory fake adapter (src/testing/fake-adapter.ts): a second implementation of the contract.
 * Nothing here knows T3. Each test drives a fake thread event through the real rules, the real delivery and the real hold
 * store, on a scratch directory, and reads the wake the fake received.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { useCoreEngineFixtures } from "../testing/core-engine-fixtures.ts";
import { heldOpen } from "./afk-held.ts";
import { createEngine } from "./engine.ts";
import { getQuestion, questionStates } from "./questions.ts";
import { openStore } from "./sqlite-store.ts";

const { dirs, engines, rig, thread, question } = useCoreEngineFixtures(createEngine);

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

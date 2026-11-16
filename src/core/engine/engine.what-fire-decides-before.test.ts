/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import type { ThreadInput } from "../adapter/adapter.ts";
import type { WaitingItem } from "../adapter/adapter-waiting.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned, question } = useCoreEngineFixtures(createEngine);

describe("what a fire decides before it wakes the Steward", () => {
	const principalDriven = (
		r: ReturnType<typeof rig>,
		id: string,
		lastMessage: string,
		over: Partial<ThreadInput> = {},
	) => {
		r.fake.threads.set(id, {
			lastMessage,
			instruction: {
				items: [{ type: "user_message", id: "u1", text: "fix it", createdBy: "user", creationSource: "web" }],
				state: "complete",
				byMachine: false,
			},
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", over) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", over) });
	};

	test("the Decisions thread wakes no one for a question, but a failure still does", async () => {
		const r = rig({ decisions: "dec-1" });
		r.fake.threads.set("dec-1", { lastMessage: "x", waiting: [question] });
		r.fake.emit({ kind: "needs_input", thread: thread("dec-1", "waiting", { pendingRequestId: "req-1" }) });
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-decisions-thread"));
		expect(r.events.find((e) => e.event === "skip-decisions-thread")).toEqual({
			event: "skip-decisions-thread",
			kind: "needs_input",
		});
		await r.quiet();
		expect(r.fake.wakes).toEqual([]);
		r.fake.emit({ kind: "state", thread: thread("dec-1", "failed", { latestRunId: "run-1" }) });
		await r.until("the failed wake", () => r.fake.wakes.length === 1);
	});

	test("a turn that ends on a promise of next work wakes as stalled", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.threads.set("t1", {
			instruction: { items: [stewardSigned], state: "complete", byMachine: false },
			lastMessage: "When the tests finish I'll start the migration.",
		});
		r.fake.emit({ kind: "state", thread: thread("t1", "running") });
		r.fake.emit({ kind: "state", thread: thread("t1", "completed") });
		await r.until("the wake", () =>
			r.fake.wakes.some(
				(w) =>
					!w.deliveryId.includes(":rights-first:") &&
					w.message.includes("ended its turn on a promise of next work and is now idle (stalled)"),
			),
		);
		expect(
			r.fake.wakes.some((w) =>
				w.message.includes("ended its turn on a promise of next work and is now idle (stalled)"),
			),
		).toBe(true);
	});

	test("a thread that went idle with an open PR wakes with the open work named", async () => {
		const r = rig({ steward: "steward-1" });
		principalDriven(r, "t7", "All done and verified.\n\n🗣️ Done.", { openPrs: [7, 9] });
		await r.until("the wake", () =>
			r.fake.wakes.some(
				(w) =>
					!w.deliveryId.includes(":rights-first:") &&
					w.message.includes("went idle with work still open: open PR #7, #9"),
			),
		);
		const w = r.fake.wakes.find(
			(x) => !x.deliveryId.includes(":rights-first:") && x.message.includes("went idle with work still open"),
		)!;
		expect(w.message).toContain("went idle with work still open: open PR #7, #9");
		expect(w.deliveryId).toMatch(/^t7:ended:/);
	});

	test("a wait with nothing on it is skipped, and says so", async () => {
		const r = rig();
		r.fake.threads.set("t1", { lastMessage: "x", waiting: [] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting") });
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-empty-wait"));
		expect(r.events.find((e) => e.event === "skip-empty-wait")).toEqual({
			event: "skip-empty-wait",
			server: "fake",
			threadId: "t1",
		});
		expect(r.fake.wakes).toEqual([]);
	});

	test("a secret request says it is the operator's alone; a request already seen wakes no second time", async () => {
		const r = rig();
		const secret: WaitingItem = { type: "secret_request", requestId: "sec-1", label: "API key", questions: [] };
		r.fake.threads.set("t1", { lastMessage: "need a key", waiting: [secret] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "sec-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain(
			"WAITING ON: a SECRET request. Never answer it and never supply a value; it is",
		);
		expect(r.fake.wakes[0]!.message).toContain("(API key)");
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "sec-2" }) });
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-request-seen"));
		expect(r.fake.wakes).toHaveLength(1);
	});

	test("a worktree whose commits cannot be counted is logged, and the turn end is skipped, not reported", async () => {
		const r = rig({ steward: "steward-1" });
		principalDriven(r, "t8", "All done and verified.", { worktreePath: `${r.conf}/no-such-worktree` });
		await r.until("the log", () => r.events.some((e) => e.event === "idle-check-failed"));
		const line = r.events.find((e) => e.event === "idle-check-failed");
		expect(line).toMatchObject({ server: "fake", threadId: "t8" });
		expect(String(line?.error)).toContain("exited");
		await r.until("the skip", () => r.events.some((e) => e.event === "skip-turn-ended"));
		expect(r.fake.wakes).toEqual([]);
	});

	test("a card question the queue refuses is logged, once for a refusal and once for a throw, and the hold stands", async () => {
		const r = rig();
		r.store.away.enter({ enteredAt: "2026-11-12T10:00:00Z", words: "back at five" });
		const approval = (id: string): WaitingItem => ({
			type: "approval_request",
			requestId: id,
			label: "x",
			questions: [],
		});
		let mode: "refuse" | "throw" = "refuse";
		r.fake.post = async () => {
			if (mode === "throw") throw Error("queue down");
			return { ok: false, detail: "no queue".repeat(60), where: "notice" };
		};
		r.fake.threads.set("t1", { waiting: [approval("a1")] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a1" }) });
		await r.until("the refusal", () => r.events.some((e) => e.event === "card-question-post-failed"));
		mode = "throw";
		r.fake.threads.set("t1", { waiting: [approval("a1"), approval("a2")] });
		r.fake.emit({ kind: "needs_input", thread: thread("t1", "waiting", { pendingRequestId: "a2" }) });
		await r.until("the throw", () => r.events.filter((e) => e.event === "card-question-post-failed").length === 2);
		const failed = r.events.filter((e) => e.event === "card-question-post-failed");
		expect(failed[0]).toEqual({
			event: "card-question-post-failed",
			server: "fake",
			threadId: "t1",
			detail: `${"no queue".repeat(60).slice(0, 200)}…`,
		});
		expect(failed[1]).toEqual({
			event: "card-question-post-failed",
			server: "fake",
			threadId: "t1",
			detail: "Error: queue down",
		});
		expect(heldOpen(r.store)).toHaveLength(2);
		expect(r.fake.wakes).toEqual([]);
	});
});

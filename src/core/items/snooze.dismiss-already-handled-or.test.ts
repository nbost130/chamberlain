/** snooze, continued: see snooze.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreSnoozeFixtures } from "../../testing/core-snooze-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { reconcileItemHolds } from "../decide/hold-reconcile.ts";
import { HELD, heldOpen } from "../ops/afk-held.ts";
import type { Store } from "../store/store.ts";
import { askQuestion, getQuestion, questionStates } from "./questions.ts";
import { claimWake, pageClaim } from "./questions-claim.ts";
import { answerWake, DISMISSED_LABEL, plainAnswer, ranked, recordAnswerDelivered } from "./questions-wake.ts";
import { findSettled } from "./settled.ts";

const { NOW, iso, question, hold, stateOf } = useCoreSnoozeFixtures();

describe("dismiss: already handled, or no longer needed", () => {
	const dismissed = (store: Store, id: string, note?: string) => {
		const q = question(id, { title: "Whether the billing retry runs hourly or daily" });
		askQuestion(store, q);
		const claim = pageClaim(q, plainAnswer("dismissed", id, note, iso(NOW)));
		expect(claimWake(store, claim).won).toBe(true);
		return { q, claim };
	};
	test("is recorded as dismissed, never as an answer: no `answer`, a `dismissal` with the note", () => {
		const store = memStore();
		dismissed(store, "Q-dis01", "already done in the thread");
		const s = stateOf(store, "Q-dis01");
		expect(s.status).toBe("dismissed");
		expect(s.answer).toBeUndefined();
		expect(s.dismissal).toEqual({ note: "already done in the thread", t: iso(NOW) });
		expect(ranked(questionStates(store).values())).toEqual([]);
		expect(plainAnswer("dismissed", "Q-dis01", undefined, iso(NOW))).toMatchObject({
			label: DISMISSED_LABEL,
			choice: -1,
		});
		expect(getQuestion(store, "Q-dis01")?.status).toBe("dismissed");
	});
	test("sends the Steward a short wake that says dismissed, not answered, and carries the note, or says there is none", () => {
		const store = memStore();
		const { claim } = dismissed(store, "Q-dis02", "no longer needed");
		expect(claim.message.startsWith("[chamberlain] answer:")).toBe(true);
		expect(claim.message).toContain("dismissed decision-queue item Q-dis02");
		expect(claim.message).toContain("not an answer");
		expect(claim.message).toContain("note: no longer needed");
		expect(claim.message).not.toMatch(/answered decision-queue item/);
		const bare = pageClaim(question("Q-dis03"), plainAnswer("dismissed", "Q-dis03", undefined, iso(NOW)));
		expect(bare.message).toContain("note: none");
		expect(answerWake(question("Q-dis03"), bare.answer!)).toBe(bare.message);
	});
	test("closes its hold, and records that it was dismissed", () => {
		const store = memStore();
		const h = hold(store, "Q-dis04");
		dismissed(store, "Q-dis04");
		expect(reconcileItemHolds(store, new Date(NOW + 1)).closed).toBe(1);
		expect(heldOpen(store)).toEqual([]);
		expect(String(store.items.get(HELD, h)?.payload.how)).toContain("Dismissed on the queue");
		expect(String(store.items.get(HELD, h)?.payload.how)).not.toContain("Answered");
	});
	test("stays dismissed after its wake is delivered", () => {
		const store = memStore();
		dismissed(store, "Q-dis05");
		recordAnswerDelivered(store, "answer:item:Q-dis05");
		expect(stateOf(store, "Q-dis05")).toMatchObject({ status: "dismissed", delivered: true });
	});
	test("is ignored by settled-question lookups, while an answered question is found", () => {
		const store = memStore();
		const { q } = dismissed(store, "Q-dis06", "handled elsewhere");
		expect(findSettled(store, { title: q.title, thread: q.thread }, {}).matches).toEqual([]);
		expect(findSettled(store, { title: `look at ${q.id}`, item: q.id }, {}).matches).toEqual([]);
		// control: the same question, answered with an option, is settled
		const answered = question("Q-ans01", { title: q.title });
		askQuestion(store, answered);
		claimWake(
			store,
			pageClaim(answered, { choice: 1, label: "Plan B", by: "page", t: iso(NOW), deliveryId: "answer:item:Q-ans01" }),
		);
		const found = findSettled(store, { title: q.title, thread: q.thread }, {}).matches;
		expect(found.map((m) => m.id)).toEqual(["Q-ans01"]);
	});
});

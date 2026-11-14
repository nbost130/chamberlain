import { type Answer, askQuestion, notNow, type Question } from "../core/questions.ts";
import { claimWake, pageClaim } from "../core/questions-claim.ts";
import type { Store } from "../core/store.ts";
import { memStore } from "./store.ts";

export const item = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Question ${id}`,
	context: "",
	options: [{ label: "A · One" }, { label: "B · Two" }],
	recommended: 0,
	thread: "Mobile app",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-09T10:00:00.000Z",
	...over,
});

export const answerOf = (id: string, choice = 0): Answer => ({
	choice,
	label: String(choice),
	by: "page",
	t: "2026-11-09T13:00:00.000Z",
	deliveryId: `answer:item:${id}`,
});

/** Asks each question and answers or sets aside the ones that say so, through the same functions the page uses. */
export function queue(...qs: (Question | [Question, "answer" | "not-now"])[]): Store {
	const store = memStore();
	for (const q of qs) {
		const [i, what] = Array.isArray(q) ? q : [q, undefined];
		askQuestion(store, i);
		if (what === "answer") claimWake(store, pageClaim(i, answerOf(i.id)));
		if (what === "not-now") notNow(store, i.id, "2026-11-09T12:00:00.000Z");
	}
	return store;
}

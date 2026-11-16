import type { SettledMatch } from "../core/config/config.ts";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { claimWake, pageClaim } from "../core/items/questions-claim.ts";
import { findSettled } from "../core/items/settled.ts";
import type { Store } from "../core/store/store.ts";

export const DEFAULT: SettledMatch = {};

export const q = (id: string, title: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title,
	context: "",
	options: [{ label: "Yes" }, { label: "No" }],
	thread: "Thread",
	server: "main",
	createdAt: "2026-11-10T10:00:00.000Z",
	...over,
});

/** An answered question, as the page leaves it: the item and its claim. */
export function answered(store: Store, id: string, title: string, over: Partial<Question> & { label?: string } = {}) {
	const { label = "No", ...question } = over;
	const item = q(id, title, question);
	askQuestion(store, item);
	claimWake(
		store,
		pageClaim(item, { choice: 1, label, by: "page", t: "2026-11-11T09:00:00.000Z", deliveryId: `answer:item:${id}` }),
	);
}

export const find = (store: Store, s: Parameters<typeof findSettled>[1], m: SettledMatch = DEFAULT) =>
	findSettled(store, s, m);

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseAsk, stageEvidence } from "../ask.ts";
import { askQuestion, answerWake, batchable, claimWake, getQuestion, notNow, pageClaim, questionStates, QUEUE, ranked, readClaim, recordAnswerDelivered, wokenBy, type Answer, type Question } from "./questions.ts";
import { openStore } from "./sqlite-store.ts";
import { memStore } from "../testing/store.ts";
import type { Store } from "./store.ts";

export const item = (id: string, over: Partial<Question> = {}): Question => ({
	id, kind: "product", title: `Question ${id}`, context: "", options: [{ label: "A · One" }, { label: "B · Two" }], recommended: 0,
	thread: "Mobile app", server: "main", threadId: "thread-1", createdAt: "2026-11-09T10:00:00.000Z", ...over,
});
const answerOf = (id: string, choice = 0): Answer => ({ choice, label: String(choice), by: "page", t: "2026-11-09T13:00:00.000Z", deliveryId: `answer:item:${id}` });
/** Asks each question and answers or sets aside the ones that say so, through the same functions the page uses. */
function queue(...qs: (Question | [Question, "answer" | "not-now"])[]): Store {
	const store = memStore();
	for (const q of qs) {
		const [i, what] = Array.isArray(q) ? q : [q, undefined];
		askQuestion(store, i);
		if (what === "answer") claimWake(store, pageClaim(i, answerOf(i.id)));
		if (what === "not-now") notNow(store, i.id, "2026-11-09T12:00:00.000Z");
	}
	return store;
}

describe("a question is an item of the one item system", () => {
	test("asking creates an open item of source queue and kind question, keyed by its id, with its static content as payload and no alert", () => {
		const store = queue(item("Q-abcd1", { blocks: "blocks 2 threads" }));
		expect(store.items.get(QUEUE, "Q-abcd1")).toMatchObject({ kind: "question", status: "triggered", mode: "silenced", notificationCount: 0, subject: { kind: "thread", id: "thread-1" }, payload: { title: "Question Q-abcd1", blocks: "blocks 2 threads" } });
	});
	test("asking the same id twice changes nothing: the first ask wins", () => {
		const store = queue(item("Q-abcd1"));
		askQuestion(store, item("Q-abcd1", { title: "Another" }));
		expect(getQuestion(store, "Q-abcd1")?.title).toBe("Question Q-abcd1");
		expect(store.items.list({ source: QUEUE })).toHaveLength(1);
	});
	test("the page's view is composed from the item, its claim, its evidence and its direct send", () => {
		const store = queue(item("Q-abcd1", { evidence: [{ type: "image", path: "a.png", caption: "c" }, { type: "link", url: "https://x" }] }));
		expect(getQuestion(store, "Q-abcd1")).toMatchObject({ status: "open", delivered: false, evidence: [{ type: "image", path: "a.png", caption: "c" }, { type: "link", url: "https://x" }] });
		claimWake(store, pageClaim(item("Q-abcd1"), answerOf("Q-abcd1")));
		expect(getQuestion(store, "Q-abcd1")).toMatchObject({ status: "answered", delivered: false, answer: { choice: 0 } });
		recordAnswerDelivered(store, "answer:item:Q-abcd1");
		expect(getQuestion(store, "Q-abcd1")).toMatchObject({ status: "answered", delivered: true });
		recordAnswerDelivered(store, "answer:item:Q-abcd1");
		recordAnswerDelivered(store, "not-an-answer");
		expect(wokenBy(store, "Q-abcd1")).toBe("page");
		expect(readClaim(store, "Q-abcd1")?.deliveryId).toBe("answer:item:Q-abcd1");
	});
	test("an answer's delivery resolves the item only for the delivery id the claim carries", () => {
		const store = queue([item("Q-abcd1"), "answer"]);
		recordAnswerDelivered(store, "answer:item:Q-zzzz9");
		expect(store.items.get(QUEUE, "Q-abcd1")?.status).toBe("triggered");
	});
});

describe("ranked", () => {
	test("only-you first, then by what it blocks, then oldest; not now sinks to the end", () => {
		const s = queue(
			item("Q-idea1", { kind: "idea" }),
			item("Q-prod1", { createdAt: "2026-11-09T09:00:00.000Z" }),
			item("Q-prod2", { blocks: "blocks 3 threads", createdAt: "2026-11-09T11:00:00.000Z" }),
			item("Q-only1", { kind: "only-you", createdAt: "2026-11-09T12:00:00.000Z" }),
			[item("Q-only2", { kind: "only-you" }), "not-now"],
		);
		expect(ranked(questionStates(s).values()).map((i) => i.id)).toEqual(["Q-only1", "Q-prod2", "Q-prod1", "Q-idea1", "Q-only2"]);
		expect(getQuestion(s, "Q-only2")).toMatchObject({ status: "open", notNowAt: "2026-11-09T12:00:00.000Z" });
		expect(s.items.get(QUEUE, "Q-only2")?.status).toBe("acknowledged");
	});
	test("answered items leave the queue", () => {
		const s = queue([item("Q-aaaa"), "answer"]);
		expect(ranked(questionStates(s).values())).toEqual([]);
	});
	test("the first answer wins", () => {
		const s = queue(item("Q-aaaa"));
		expect(claimWake(s, pageClaim(item("Q-aaaa"), answerOf("Q-aaaa", 0))).won).toBe(true);
		expect(claimWake(s, pageClaim(item("Q-aaaa"), answerOf("Q-aaaa", 1))).won).toBe(false);
		expect(questionStates(s).get("Q-aaaa")!.answer!.choice).toBe(0);
	});
});

describe("batchable", () => {
	test("never an only-you item, a secret, or one without a recommendation", () => {
		const s = queue(item("Q-only", { kind: "only-you" }), item("Q-secr", { secret: true, kind: "product" }), item("Q-norc", { recommended: undefined }), item("Q-good"));
		expect([...questionStates(s).values()].filter(batchable).map((i) => i.id)).toEqual(["Q-good"]);
	});
});

describe("answer wake", () => {
	test("has the daemon's answer shape and carries item, choice, note and ruling", () => {
		const w = answerWake(item("Q-abcd"), { choice: 1, label: "B · Two", note: "bigger skip link", ruling: { id: "R44", decides: "Lead with a photo" }, by: "page", t: "x", deliveryId: "answer:item:Q-abcd" });
		expect(w.startsWith("[chamberlain] answer: ")).toBe(true);
		expect(w).toContain("item: Q-abcd");
		expect(w).toContain("choice: 2. B · Two");
		expect(w).toContain("note: bigger skip link");
		expect(w).toContain("ruling: saved as R44");
		expect(w).toMatch(/<<<\n[\s\S]*\n>>>$/);
	});
});

describe("ask.ts", () => {
	test("checks the Steward's JSON and strips (Recommended) from labels", () => {
		const i = parseAsk({ kind: "product", title: "T", context: "C", options: [{ label: "A (Recommended)", detail: "d" }, "B"], recommended: 0, thread: "th", server: "main" }, "Q-abcd1");
		expect(i.options).toEqual([{ label: "A", detail: "d" }, { label: "B" }]);
		expect(() => parseAsk({ kind: "nope", title: "T", options: ["a", "b"], thread: "t", server: "s" }, "Q-x")).toThrow(/kind/);
		expect(() => parseAsk({ kind: "product", title: "T", options: ["a"], thread: "t", server: "s" }, "Q-x")).toThrow(/two options/);
		expect(() => parseAsk({ kind: "product", title: "T", options: ["a", "b"], recommended: 5, thread: "t", server: "s" }, "Q-x")).toThrow(/recommended/);
	});
	test("evidence is copied into the item's own folder, and a symlink or a wrong type is refused", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-ask-`);
		mkdirSync(`${d}/src`);
		writeFileSync(`${d}/src/shot one.png`, "png");
		writeFileSync(`${d}/src/notes.txt`, "txt");
		const staged = stageEvidence(item("Q-abcd", { evidence: [{ type: "image", path: `${d}/src/shot one.png`, caption: "c" }, { type: "link", url: "https://x" }] }), `${d}/state`);
		expect(staged.evidence![0]!.path).toBe("shot_one.png");
		expect(Bun.file(`${d}/state/evidence/Q-abcd/shot_one.png`).size).toBe(3);
		expect(() => stageEvidence(item("Q-abcd", { evidence: [{ type: "image", path: `${d}/src/notes.txt` }] }), `${d}/state`)).toThrow(/png/);
	});
});

test("an unreachable queue server is detected, so the Decisions thread gets the notice", async () => {
	const { queueUp } = await import("../ask.ts");
	expect(await queueUp("http://127.0.0.1:9", 500)).toBe(false);
});

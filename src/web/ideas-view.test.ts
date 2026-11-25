import { expect, test } from "bun:test";
import { askQuestion, getQuestion, QUEUE } from "../core/items/questions.ts";
import { newToken } from "../core/ops/capability.ts";
import { useWebQueueActionsFixtures } from "../testing/web-queue-actions-fixtures.ts";
import { item, page } from "../testing/web-queue-actions-view-fixtures.ts";

const { setup, question, T0, wakes } = useWebQueueActionsFixtures();

test("the full page keeps Ideas and Waiting in separate counted lists", async () => {
	const p = await page(() => ({
		items: [item("Q-wait", { title: "Waiting question" })],
		ideas: [item("Q-idea", { kind: "idea", urgent: false, title: "Idea to review" })],
	}));
	expect(p.html()).toContain('data-list="waiting" aria-pressed="true">Waiting 1');
	expect(p.html()).toContain('data-list="ideas" aria-pressed="false">Ideas 1');
	expect(p.html()).toContain("Waiting question");
	expect(p.html()).not.toContain("Idea to review");
	await p.tap({ list: "ideas" });
	expect(p.html()).toContain('data-list="ideas" aria-pressed="true">Ideas 1');
	expect(p.html()).toContain("Idea to review");
	expect(p.html()).toContain("not urgent");
	expect(p.html()).not.toContain("Waiting question");
	await p.tap({ list: "waiting" });
	expect(p.html()).toContain("Waiting question");
});

test("the page and the view key read a legacy idea as silent and can record its approval", async () => {
	const sent: string[] = [];
	const s = setup({ sent });
	const idea = question("Q-idea", {
		kind: "idea",
		context: "Blocked by: example/project#4",
		options: [{ label: "Approve", route: "thread", relay: "Start the work" }, { label: "Decline" }],
	});
	s.store.items.observe({
		source: QUEUE,
		kind: "question",
		dedupKey: idea.id,
		mode: "silenced",
		payload: idea,
		now: T0,
	});
	askQuestion(s.store, question("Q-wait"), T0);
	const key = newToken();
	s.cap.state.viewKey = key;
	const queue = await s.call("GET", "/api/queue", { origin: "null", key });
	expect(queue.status).toBe(200);
	expect(await queue.json()).toMatchObject({
		items: [expect.objectContaining({ id: "Q-wait" })],
		ideas: [expect.objectContaining({ id: "Q-idea", urgent: false })],
	});
	expect(s.app.openCount()).toBe(1);
	const route = "/api/items/Q-idea/answer";
	expect((await s.call("POST", route, { origin: "null", key, body: { choice: 0, saveRuling: true } })).status).toBe(
		403,
	);
	expect((await s.call("POST", route, { origin: "null", key, body: { choice: 0 } })).status).toBe(200);
	expect(getQuestion(s.store, idea.id)?.answer).toMatchObject({ label: "Approve", key: "view" });
	expect(sent).toEqual([]);
	expect(wakes(s)[0]?.message).toContain("file an issue and link any predecessor as blocked-by");
	expect(wakes(s)[0]?.message).toContain(idea.context);
});

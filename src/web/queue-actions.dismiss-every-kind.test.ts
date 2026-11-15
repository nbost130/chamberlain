/**
 * Every queue item kind can be dismissed (#68): the button's API succeeds, records a dismissal (never an answer), closes the
 * item's afk hold and queues the Steward's wake. A secret whose box has ended is the regression case that stayed open before.
 */
import { describe, expect, test } from "bun:test";
import { heldOpen } from "../core/afk-held.ts";
import { closeCard, holdCard } from "../core/card-hold.ts";
import { askQuestion, getQuestion, type Kind } from "../core/questions.ts";
import { findSettled } from "../core/settled.ts";
import { useWebQueueActionsFixtures } from "../testing/web-queue-actions-fixtures.ts";

const { T0, question, setup, hold, wakes } = useWebQueueActionsFixtures();

/** Queue kinds the page and inline view render as decision cards, plus the two shapes that used to refuse dismiss. */
const KINDS: { name: string; id: string; over: Parameters<typeof question>[1] }[] = [
	{ name: "only-you", id: "Q-oyou", over: { kind: "only-you" satisfies Kind } },
	{ name: "product (question)", id: "Q-prod", over: { kind: "product" satisfies Kind } },
	{ name: "ruling", id: "Q-rule", over: { kind: "ruling" satisfies Kind } },
	{ name: "idea", id: "Q-idea", over: { kind: "idea" satisfies Kind } },
	{ name: "secret", id: "Q-secr", over: { kind: "only-you", secret: true, options: [], tag: "Secret" } },
	{
		name: "card-backed (approval pointer)",
		id: "Q-capv",
		over: { kind: "only-you", cardRequest: "req-approve", tag: "Approval", options: [{ label: "Leave it" }] },
	},
	{
		name: "card-backed secret pointer",
		id: "Q-csec",
		over: {
			kind: "only-you",
			secret: true,
			cardRequest: "req-secret",
			options: [],
			tag: "Secret",
		},
	},
];

describe("dismiss every kind (#68)", () => {
	for (const { name, id, over } of KINDS) {
		test(`${name}: dismiss succeeds, records no answer, closes the hold and wakes the Steward`, async () => {
			const s = setup();
			const q = question(id, { title: `Dismiss ${name}`, ...over });
			askQuestion(s.store, q);
			const h = hold(s.store, id);
			expect(heldOpen(s.store).some((x) => x.item === id)).toBe(true);

			const r = await s.post(id, "dismiss", {});
			expect([name, r.status, await r.json()]).toEqual([
				name,
				200,
				{ ok: true, id, kind: "dismissed", recorded: true, to: "steward", wake: "queued" },
			]);

			const state = getQuestion(s.store, id)!;
			expect(state.status).toBe("dismissed");
			expect(state.answer).toBeUndefined();
			expect(state.dismissal).toMatchObject({ t: expect.any(String) });
			expect(heldOpen(s.store).filter((x) => x.item === id && !x.card && !x.requestId)).toEqual([]);
			expect(String(s.store.items.get("held", h)?.payload.how)).toContain("Dismissed");
			expect(findSettled(s.store, { title: q.title, thread: q.thread }, {}).matches).toEqual([]);

			const [wake] = wakes(s);
			expect(wake!.id).toBe(`answer:item:${id}`);
			expect(wake!.message).toContain(`dismissed decision-queue item ${id}`);
			expect(wake!.message).toContain("not an answer");
			expect(wake!.message).toContain("Stop tracking it");
			expect(wake!.message).not.toMatch(/answered decision-queue item/);
			if (over?.cardRequest) {
				expect(wake!.message).toContain("card stays in its thread");
				expect(wake!.message).toContain("was not answered or approved");
			}
			if (over?.secret) expect(wake!.message).toContain("no secret was entered on the page");
		});
	}

	test("regression: a secret whose card has ended dismisses, with no answer and a wake that says stop tracking", async () => {
		const s = setup();
		const id = "Q-ended";
		askQuestion(
			s.store,
			question(id, {
				kind: "only-you",
				secret: true,
				options: [],
				tag: "Secret",
				title: "sudo password for the install",
			}),
		);
		hold(s.store, id);
		// The page surfaces secretRequest: "ended" from the mirror; dismiss must still work when the box is gone.
		const r = await s.post(id, "dismiss", { note: "card already closed" });
		expect(r.status).toBe(200);
		expect(getQuestion(s.store, id)).toMatchObject({
			status: "dismissed",
			dismissal: { note: "card already closed" },
		});
		expect(getQuestion(s.store, id)!.answer).toBeUndefined();
		expect(heldOpen(s.store)).toEqual([]);
		const [wake] = wakes(s);
		expect(wake!.message).toContain("dismissed decision-queue item Q-ended");
		expect(wake!.message).toContain("no secret was entered on the page");
		expect(wake!.message).toContain("note: card already closed");
	});

	test("dismissing a card-backed item leaves the card alone; the item stays dismissed when the card later resolves", async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Release",
			server: "main",
			threadId: "th-1",
			requestId: "a1",
			type: "approval_request",
			label: "bun run deploy",
		});
		expect(getQuestion(s.store, id)!.status).toBe("open");
		expect(getQuestion(s.store, id)!.cardRequest).toBe("a1");
		expect(heldOpen(s.store).some((h) => h.card?.requestId === "a1")).toBe(true);

		expect((await s.post(id, "dismiss", {})).status).toBe(200);
		expect(getQuestion(s.store, id)!.status).toBe("dismissed");
		expect(getQuestion(s.store, id)!.answer).toBeUndefined();
		// The card hold stays with the card in its thread; only non-card afk holds close with the dismissal.
		expect(heldOpen(s.store).some((h) => h.card?.requestId === "a1")).toBe(true);
		const [wake] = wakes(s);
		expect(wake!.message).toContain("card stays in its thread");

		closeCard(s.store, { server: "main", requestId: "a1", threadId: "th-1" }, "approved in its thread", {
			now: new Date(T0 + 1),
		});
		expect(getQuestion(s.store, id)!.status).toBe("dismissed");
		expect(heldOpen(s.store).filter((h) => h.card?.requestId === "a1")).toEqual([]);
	});

	test("direction is still refused for a secret and a card pointer", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-sec2", { secret: true, options: [] }));
		askQuestion(s.store, question("Q-ptr2", { cardRequest: "req-2" }));
		for (const id of ["Q-sec2", "Q-ptr2"]) {
			const r = await s.post(id, "direction", { note: "go" });
			expect([id, r.status >= 400]).toEqual([id, true]);
			expect(getQuestion(s.store, id)!.status).toBe("open");
		}
		expect(wakes(s)).toEqual([]);
	});
});

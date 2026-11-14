/**
 * Snooze, un-snooze, direction and dismiss through the page's API: what each route does to the queue, the Steward's wake and the afk
 * hold, and who may call it. Each test drives the real handler (createApp) over a real store and, for who may call, a real capability.
 */

import { describe, expect, test } from "bun:test";
import { HELD, heldOpen } from "../core/afk-held.ts";
import { reconcileItemHolds } from "../core/hold-reconcile.ts";
import { askQuestion, QUEUE, questionStates } from "../core/questions.ts";
import { readRelay } from "../core/questions-claim.ts";
import { useWebQueueActionsFixtures } from "../testing/web-queue-actions-fixtures.ts";

const { T0, HOUR, iso, question, setup, world, hold, wakes } = useWebQueueActionsFixtures();

describe("snooze", () => {
	test("takes the item off the active list into a Snoozed one that says when it returns; the item stays open and its hold stays open", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-bbbb"));
		const h = hold(s.store, "Q-aaaa");
		const r = await s.post("Q-aaaa", "snooze");
		expect([r.status, await r.json()]).toEqual([200, { ok: true, id: "Q-aaaa", until: iso(T0 + 2 * HOUR) }]);
		const q = await s.queue();
		expect(q.items.map((i) => i.id)).toEqual(["Q-bbbb"]);
		expect(q.snoozed.map((i) => [i.id, i.status, i.snooze.until, i.snooze.active])).toEqual([
			["Q-aaaa", "open", iso(T0 + 2 * HOUR), true],
		]);
		expect(wakes(s)).toEqual([]); // not answered: no claim, no wake
		expect(reconcileItemHolds(s.store, new Date(T0)).closed).toBe(0);
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(JSON.stringify(s.store.items.get(HELD, h)?.payload.notes)).toContain("2026-11-14T14:00Z");
		expect(s.logs.some((l) => l.event === "snoozed")).toBe(true);
	});

	test("a snoozed item does not count toward the open count the Decisions title shows, and is not batch-accepted", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-bbbb"));
		await s.post("Q-aaaa", "snooze");
		expect(s.app.openCount()).toBe(1);
		const r = await (await s.page("POST", "/api/accept-all", { ids: ["Q-aaaa", "Q-bbbb"] })).json();
		expect(r.answered).toEqual(["Q-bbbb"]);
		expect(r.skipped).toEqual([{ id: "Q-aaaa", why: "no recommendation" }]);
	});

	test("a batch decided before the snooze is refused for that item inside the serialized step", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		const r = await s.app.answer("Q-aaaa", { choice: 0 }, "batch");
		expect([r.status, (r.body as { error: string }).error]).toEqual([409, "snoozed: it is off the active list"]);
		expect(wakes(s)).toEqual([]);
		// a plain answer to a snoozed item is still allowed
		expect((await s.app.answer("Q-aaaa", { choice: 0 }, "page")).status).toBe(200);
	});

	test("the queue lists an item in exactly one of its two lists, even when its time arrives between two reads of the clock", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		const until = T0 + 2 * HOUR;
		let reads = 0;
		Object.defineProperty(s.clock, "t", { get: () => (reads++ === 0 ? until - 1 : until) });
		const q = await s.queue();
		expect(q.items.length + q.snoozed.length).toBe(1);
	});

	test("comes back on its own when its time arrives, with no request and nothing run", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		expect((await s.queue()).items).toEqual([]);
		s.clock.t = T0 + 2 * HOUR - 1;
		expect((await s.queue()).items).toEqual([]);
		s.clock.t = T0 + 2 * HOUR;
		const q = await s.queue();
		expect(q.items.map((i) => i.id)).toEqual(["Q-aaaa"]);
		expect(q.snoozed).toEqual([]);
		expect(s.app.openCount()).toBe(1);
	});

	test("survives a restart of the page over the same database, and returns on time", async () => {
		const first = setup();
		askQuestion(first.store, question("Q-aaaa"));
		await first.post("Q-aaaa", "snooze");
		first.store.close();
		const second = setup({ root: first.root, now: { t: T0 + HOUR } });
		let q = await second.queue();
		expect([q.items, q.snoozed.map((i) => i.id)]).toEqual([[], ["Q-aaaa"]]);
		second.clock.t = T0 + 2 * HOUR;
		q = await second.queue();
		expect([q.items.map((i) => i.id), q.snoozed]).toEqual([["Q-aaaa"], []]);
	});

	test("un-snooze returns it at once; one that is not snoozed, or is not open, says so", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		const r = await s.post("Q-aaaa", "unsnooze");
		expect([r.status, await r.json()]).toEqual([200, { ok: true, id: "Q-aaaa" }]);
		expect((await s.queue()).items.map((i) => i.id)).toEqual(["Q-aaaa"]);
		expect((await s.post("Q-aaaa", "unsnooze")).status).toBe(409);
		expect((await s.post("Q-nope", "unsnooze")).status).toBe(404);
		expect((await s.post("Q-nope", "snooze")).status).toBe(404);
	});

	test("takes only a time that is ahead, within a year; anything else writes nothing", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		const before = world(s.store);
		for (const until of [
			undefined,
			null,
			7,
			"",
			"soon",
			"2026-11-14T15:00:00",
			iso(T0 - HOUR),
			iso(T0),
			iso(T0 + 400 * 24 * HOUR),
		]) {
			const r = await s.post("Q-aaaa", "snooze", { until });
			expect([until, r.status]).toEqual([until, 400]);
		}
		expect(world(s.store)).toBe(before);
	});

	test("an answer from another surface ends the snooze: a plain answer from an inline frame, with the key", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		const r = await s.call("POST", "/api/items/Q-aaaa/answer", { origin: "null", key: s.token, body: { choice: 1 } });
		expect(r.status).toBe(200);
		const state = questionStates(s.store, T0).get("Q-aaaa")!;
		expect([state.status, state.snooze]).toEqual(["answered", undefined]);
		expect(s.store.items.get(QUEUE, "Q-aaaa")?.payload.snoozedUntil).toBeUndefined();
		expect((await s.queue()).snoozed).toEqual([]);
		expect(wakes(s)).toHaveLength(1);
	});

	test("an answer from the full page ends it too, and answering a snoozed item is allowed", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		expect((await s.post("Q-aaaa", "answer", { choice: 0 })).status).toBe(200);
		expect(s.store.items.get(QUEUE, "Q-aaaa")?.payload.snoozedUntil).toBeUndefined();
	});
});

describe("direction: a note and no option", () => {
	test("needs a note: none, blank or not text is refused and writes nothing", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		const before = world(s.store);
		for (const note of [undefined, "", "   \n", 5, { a: 1 }]) {
			const r = await s.post("Q-aaaa", "direction", { note });
			expect([note, r.status]).toEqual([note, 400]);
		}
		expect(world(s.store)).toBe(before);
	});

	test("leaves the queue as an answer and wakes the Steward: names the item, says no option was chosen, carries the note", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		const r = await s.post("Q-aaaa", "direction", { note: "  Go with A, skip the migration  " });
		expect([r.status, await r.json()]).toEqual([
			200,
			{ ok: true, id: "Q-aaaa", kind: "direction", recorded: true, to: "steward", wake: "queued" },
		]);
		expect((await s.queue()).items).toEqual([]);
		const [wake] = wakes(s);
		expect(wake!.id).toBe("answer:item:Q-aaaa");
		expect(wake!.message.startsWith("[chamberlain] answer:")).toBe(true);
		expect(wake!.message).toContain("Q-aaaa");
		expect(wake!.message).toContain("direction, no option chosen");
		expect(wake!.message).toContain("note: Go with A, skip the migration");
		expect(questionStates(s.store, T0).get("Q-aaaa")).toMatchObject({
			status: "answered",
			answer: { kind: "direction", choice: -1, note: "Go with A, skip the migration" },
		});
	});

	test("never takes the direct thread relay, even when its options route to the thread", async () => {
		const sent: string[] = [];
		const s = setup({ sent });
		askQuestion(
			s.store,
			question("Q-aaaa", {
				options: [
					{ label: "A", route: "thread", relay: "do A" },
					{ label: "B", route: "thread", relay: "do B" },
				],
			}),
		);
		await s.post("Q-aaaa", "direction", { note: "neither: do C" });
		await s.app.idle();
		expect(sent).toEqual([]);
		expect(readRelay(s.store, "Q-aaaa").started).toBe(false);
		expect(wakes(s)).toHaveLength(1);
	});

	test("closes its afk hold the moment it settles; the reconciler finds nothing left", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		const h = hold(s.store, "Q-aaaa");
		await s.post("Q-aaaa", "direction", { note: "go" });
		// closed by the page the moment it settled the item, with the daemon stopped; the reconciler then has nothing left to do
		expect(heldOpen(s.store)).toEqual([]);
		expect(reconcileItemHolds(s.store, new Date(T0)).closed).toBe(0);
		expect(String(s.store.items.get(HELD, h)?.payload.how)).toContain("direction, no option chosen");
	});

	test("ends a snooze, and is refused twice, for a secret and for a card pointer", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-sec1", { secret: true, options: [] }));
		askQuestion(s.store, question("Q-ptr1", { cardRequest: "req-1" }));
		await s.post("Q-aaaa", "snooze");
		expect((await s.post("Q-aaaa", "direction", { note: "go" })).status).toBe(200);
		expect(s.store.items.get(QUEUE, "Q-aaaa")?.payload.snoozedUntil).toBeUndefined();
		expect((await s.post("Q-aaaa", "direction", { note: "again" })).status).toBe(409);
		expect(wakes(s)).toHaveLength(1);
		const before = world(s.store);
		for (const id of ["Q-sec1", "Q-ptr1"])
			for (const route of ["direction", "dismiss"] as const) {
				const r = await s.post(id, route, { note: "x" });
				expect([id, route, r.status >= 400]).toEqual([id, route, true]);
			}
		expect(world(s.store)).toBe(before);
	});
});

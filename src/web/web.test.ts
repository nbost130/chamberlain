import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { reconcileItemHolds } from "../core/decide/hold-reconcile.ts";
import { holdCard } from "../core/items/card-hold.ts";
import { reconcileCardHolds } from "../core/items/card-reconcile.ts";
import { getQuestion, questionStates } from "../core/items/questions.ts";
import { claimWake, pageClaim } from "../core/items/questions-claim.ts";
import { heldOpen } from "../core/ops/afk-held.ts";
import { HEALTH_KEY } from "../core/steward/steward-health.ts";
import { dbPath } from "../core/store/store.ts";
import { fetchWake } from "../testing/wake.ts";
import { useWebWebFixtures } from "../testing/web-web-fixtures.ts";

const { item, setup } = useWebWebFixtures(fetchWake);

describe("answering an item", () => {
	test("queue includes latest health measurement without changing the queue", async () => {
		const s = setup();
		expect((await (await s.get("/api/queue")).json()).health).toBeNull();
		s.store.state.set(HEALTH_KEY, { verdict: "WATCH", at: "2026-11-10T14:00:00Z", report: "context near limit" });
		const data = await (await s.get("/api/queue", { origin: "null" })).json();
		expect(data.health.verdict).toBe("WATCH");
		expect(data.items).toEqual([]);
	});
	test("produces exactly one answer wake, and a second answer is refused", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 1, note: "make the skip link bigger" });
		expect(r.status).toBe(200);
		await s.app.idle();
		const again = await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		expect(again.status).toBe(409);
		await s.app.idle();
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.deliveryId).toBe("answer:item:Q-abcd");
		expect(s.posts[0]!.message.startsWith("[chamberlain] answer: ")).toBe(true);
		expect(s.posts[0]!.message).toContain("item: Q-abcd");
		expect(s.posts[0]!.message).toContain("choice: 2. B · Two");
		expect(s.posts[0]!.message).toContain("note: make the skip link bigger");
		expect(getQuestion(s.store, "Q-abcd")!.delivered).toBe(true);
	});
	test("two answers sent at once still give one wake", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const rs = await Promise.all([
			s.post("/api/items/Q-abcd/answer", { choice: 0 }),
			s.post("/api/items/Q-abcd/answer", { choice: 1 }),
		]);
		await s.app.idle();
		expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(s.posts).toHaveLength(1);
	});
	test("a retried delivery keeps its one delivery ID and lands once", async () => {
		const s = setup({ status: (n) => (n <= 2 ? 503 : 202) });
		s.add(item("Q-abcd"));
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(new Set(s.posts.map((p) => p.deliveryId))).toEqual(new Set(["answer:item:Q-abcd"]));
		expect(s.delivered()).toHaveLength(1);
		// A heartbeat afterwards sends nothing more: the answer is recorded as delivered.
		await s.app.recover();
		expect(s.posts).toHaveLength(3);
	});
	test("a wake that never delivered is attempted three times, then kept as a dead letter that recovery neither re-sends nor re-queues", async () => {
		const s = setup({ status: () => 503 });
		s.add(item("Q-abcd"));
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(s.posts).toHaveLength(3);
		expect(s.store.wakes.rows("dead_letter").map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		await s.tick();
		expect(s.posts).toHaveLength(3);
	});
	test("restart: a wake queued while no daemon ran is sent once by the next one, then never again", async () => {
		const first = setup({ relay: false });
		first.add(item("Q-abcd"));
		await first.post("/api/items/Q-abcd/answer", { choice: 0 });
		await first.app.idle();
		expect(first.delivered()).toHaveLength(0);
		// The process stops. A new one starts over the same files, and now the webhook answers.
		const second = setup({ root: first.root });
		// Held, not yet a row: the answer waits for an idle Steward (hold.ts), and the next daemon sends it.
		expect(second.store.wakes.held().map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		await second.tick();
		expect(second.delivered().map((p) => p.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(true);
		expect(second.store.wakes.rows()).toEqual([]);
		const third = setup({ root: first.root });
		await third.tick();
		await third.tick();
		expect(third.posts).toHaveLength(0);
	});
	test("restart after a crash between the delivery and the answer's delivered mark: nothing is sent twice", async () => {
		const first = setup({ relay: false });
		first.add(item("Q-abcd"));
		await first.post("/api/items/Q-abcd/answer", { choice: 0 });
		await first.app.idle();
		const second = setup({ root: first.root });
		await second.tick();
		expect(second.delivered()).toHaveLength(1);
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(true);
		// The crash: the row committed delivered, but the process died before
		// the question was marked delivered. Put the question back as it was, in the database file itself.
		const raw = new Database(dbPath(first.state));
		raw.run("UPDATE items SET state = 'triggered', resolved_at = NULL WHERE dedup_key = 'Q-abcd'");
		raw.close();
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(false);
		const third = setup({ root: first.root });
		expect(third.store.wakes.rows()).toEqual([]);
		await third.tick();
		expect(third.posts).toHaveLength(0);
		expect(getQuestion(third.store, "Q-abcd")!.delivered).toBe(true);
	});
	test("a claim with no outbox row (made before the row was part of the answer): recovery writes it, and it is sent once", async () => {
		const first = setup();
		first.add(item("Q-abcd"));
		// A claim alone, as an older page left it: the claim carries the answer and its wake, and no outbox row exists.
		const a = {
			choice: 0,
			label: "A · One",
			by: "page" as const,
			t: new Date().toISOString(),
			deliveryId: "answer:item:Q-abcd",
		};
		claimWake(first.store, pageClaim(item("Q-abcd"), a));
		expect(getQuestion(first.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: false });
		const second = setup({ root: first.root });
		await second.tick();
		const third = setup({ root: first.root });
		await third.tick();
		expect([...second.posts, ...third.posts].map((p) => p.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(second.posts[0]!.message).toContain("item: Q-abcd");
		// The page's record is derived from the claim: the item reads answered and delivered.
		expect(getQuestion(first.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: true });
	});
	test('(4) a card pointer\'s "leave it" answer is refused: the hold stays open while the card waits, and closes only when the card does', async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Release",
			server: "main",
			threadId: "th-1",
			requestId: "a1",
			type: "approval_request",
			label: "bun run deploy",
		});
		const q = getQuestion(s.store, id)!;
		// No option says the card was handled.
		expect(q.options.map((o) => o.label).join(" | ")).not.toMatch(/answered|done|handled|approved/i);
		const leave = q.options.findIndex((o) => /leave/i.test(o.label));
		const r = await s.post(`/api/items/${id}/answer`, { choice: leave });
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("act on the card itself");
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
		expect(s.store.claims.list("queue")).toEqual([]);
		expect(reconcileItemHolds(s.store)).toEqual({ closed: 0 });
		expect(
			await reconcileCardHolds(s.store, async () => ({
				ok: true as const,
				waiting: new Set(["a1"]),
				resolved: new Set<string>(),
			})),
		).toEqual({ closed: [], verified: [expect.objectContaining({ requestId: "a1" })], unverified: [], failed: [] });
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(getQuestion(s.store, id)!.status).toBe("open");
		// The card resolves: now, and only now, the question and the hold close.
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set<string>(),
					resolved: new Set(["a1"]),
				}))
			).closed,
		).toHaveLength(1);
		expect(heldOpen(s.store)).toEqual([]);
		expect(getQuestion(s.store, id)!.status).toBe("answered-on-card");
	});
	test("(4) a pointer answered before this fix (a claim already on it) does not close its hold while the card waits", async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Release",
			server: "main",
			threadId: "th-1",
			requestId: "a1",
			type: "approval_request",
			label: "deploy",
		});
		const q = getQuestion(s.store, id)!;
		claimWake(
			s.store,
			pageClaim(q, {
				choice: 1,
				label: "Leave it for now",
				by: "page",
				t: new Date().toISOString(),
				deliveryId: `answer:item:${id}`,
			}),
		);
		expect(getQuestion(s.store, id)!.status).toBe("answered");
		expect(reconcileItemHolds(s.store)).toEqual({ closed: 0 });
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set(["a1"]),
					resolved: new Set<string>(),
				}))
			).closed,
		).toEqual([]);
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set<string>(),
					resolved: new Set(["a1"]),
				}))
			).closed,
		).toHaveLength(1);
		expect(heldOpen(s.store)).toEqual([]);
	});
	test("a secret item is never answered on the page", async () => {
		const s = setup();
		s.add(item("Q-secr", { kind: "only-you", secret: true, options: [] }));
		const r = await s.post("/api/items/Q-secr/answer", { choice: 0, note: "hunter2" });
		expect(r.status).toBe(400);
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
		expect(JSON.stringify([...questionStates(s.store).values()])).not.toContain("hunter2");
		expect(s.store.claims.list("queue")).toEqual([]);
	});
});

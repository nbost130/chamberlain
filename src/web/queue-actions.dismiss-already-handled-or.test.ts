/** queue-actions, continued: see queue-actions.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { HELD, heldOpen } from "../core/afk-held.ts";
import { newToken } from "../core/capability.ts";
import { reconcileItemHolds } from "../core/hold-reconcile.ts";
import { askQuestion, QUEUE } from "../core/questions.ts";
import { findSettled } from "../core/settled.ts";
import type { Setup } from "../testing/web-queue-actions-fixtures.ts";
import { useWebQueueActionsFixtures } from "../testing/web-queue-actions-fixtures.ts";
import { inlineVerdict } from "./app-http.ts";

const { ORIGIN, T0, question, ROUTES, bodyFor, setup, world, hold, wakes } = useWebQueueActionsFixtures();

describe("dismiss: already handled, or no longer needed", () => {
	test("takes an optional note, and leaves the queue, recorded as dismissed and not as an answer", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-bbbb"));
		expect((await s.post("Q-aaaa", "dismiss", {})).status).toBe(200);
		expect((await s.post("Q-bbbb", "dismiss", { note: "  handled in the thread  " })).status).toBe(200);
		expect((await s.queue()).items).toEqual([]);
		const recent = (await (await s.page("GET", "/api/recent")).json()).items as any[];
		const byId = Object.fromEntries(recent.map((i) => [i.id, i]));
		expect(byId["Q-aaaa"]).toMatchObject({ status: "dismissed", dismissal: {} });
		expect(byId["Q-bbbb"]).toMatchObject({ status: "dismissed", dismissal: { note: "handled in the thread" } });
		expect(byId["Q-aaaa"].answer).toBeUndefined();
		expect(byId["Q-bbbb"].answer).toBeUndefined();
	});

	test("tells the Steward with a short wake that says dismissed, not answered, plus the note", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-bbbb"));
		await s.post("Q-aaaa", "dismiss", { note: "done already" });
		await s.post("Q-bbbb", "dismiss", {});
		const [a, b] = wakes(s);
		expect([a!.id, b!.id]).toEqual(["answer:item:Q-aaaa", "answer:item:Q-bbbb"]);
		expect(a!.message.startsWith("[chamberlain] answer:")).toBe(true);
		expect(a!.message).toContain("dismissed decision-queue item Q-aaaa");
		expect(a!.message).toContain("note: done already");
		expect(a!.message).toContain("not an answer");
		expect(a!.message).not.toMatch(/answered decision-queue item/);
		expect(b!.message).toContain("note: none");
	});

	test("closes its afk hold, and a settled-question lookup never sees it", async () => {
		const s = setup();
		const q = question("Q-aaaa");
		askQuestion(s.store, q);
		const h = hold(s.store, "Q-aaaa");
		await s.post("Q-aaaa", "dismiss", { note: "no longer needed" });
		expect(heldOpen(s.store)).toEqual([]);
		expect(reconcileItemHolds(s.store, new Date(T0)).closed).toBe(0);
		expect(String(s.store.items.get(HELD, h)?.payload.how)).toContain("Dismissed");
		expect(findSettled(s.store, { title: q.title, thread: q.thread }, {}).matches).toEqual([]);
		// control: the same question answered with an option is found
		askQuestion(s.store, question("Q-bbbb", { title: q.title }));
		await s.post("Q-bbbb", "answer", { choice: 0 });
		expect(findSettled(s.store, { title: q.title, thread: q.thread }, {}).matches.map((m) => m.id)).toEqual(["Q-bbbb"]);
	});

	test("ends a snooze; a dismissed item cannot be answered, directed or dismissed again", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		await s.post("Q-aaaa", "snooze");
		expect((await s.post("Q-aaaa", "dismiss", {})).status).toBe(200);
		expect(s.store.items.get(QUEUE, "Q-aaaa")?.payload.snoozedUntil).toBeUndefined();
		const again = await s.post("Q-aaaa", "dismiss", {});
		expect([again.status, (await again.json()).error]).toEqual([409, "already dismissed"]);
		for (const [route, body] of [
			["answer", { choice: 0 }],
			["direction", { note: "x" }],
		] as const) {
			const r = await s.post("Q-aaaa", route, body);
			expect([route, r.status, (await r.json()).error]).toEqual([route, 409, "already dismissed"]);
		}
		expect(wakes(s)).toHaveLength(1);
	});
});

describe("who may snooze, direct and dismiss: the same key and Origin checks as answering, and never a frame", () => {
	/** A cookie a browser holds after opening the page link. */
	const cookieOf = async (s: Setup) =>
		(
			(await s.call("GET", `/?k=${s.token}`, { headers: { accept: "text/html" } })).headers.get("set-cookie") ?? ""
		).split(";")[0]!;

	for (const route of ROUTES) {
		const path = (id: string) => `/api/items/${id}/${route}`;
		test(`${route}: with no key, a wrong key, a link key, or a missing guard header, content type or origin, nothing is written`, async () => {
			const s = setup();
			askQuestion(s.store, question("Q-aaaa"));
			if (route === "unsnooze") await s.post("Q-aaaa", "snooze");
			const before = world(s.store);
			const body = bodyFor(route);
			const refused: [string, Response][] = [
				["no key", await s.call("POST", path("Q-aaaa"), { origin: ORIGIN, body })],
				["no key, no origin", await s.call("POST", path("Q-aaaa"), { body })],
				["a wrong key", await s.call("POST", path("Q-aaaa"), { origin: ORIGIN, key: newToken(), body })],
				["a key in the address", await s.call("POST", `${path("Q-aaaa")}?k=${s.token}`, { origin: ORIGIN, body })],
				[
					"no x-decision-queue header",
					await s.call("POST", path("Q-aaaa"), {
						origin: ORIGIN,
						key: s.token,
						body,
						headers: { "x-decision-queue": "" },
					}),
				],
				[
					"a form content type",
					await s.call("POST", path("Q-aaaa"), {
						origin: ORIGIN,
						key: s.token,
						body,
						headers: { "content-type": "application/x-www-form-urlencoded" },
					}),
				],
				[
					"another site's origin",
					await s.call("POST", path("Q-aaaa"), { origin: "https://evil.example", key: s.token, body }),
				],
				[
					"another port's origin",
					await s.call("POST", path("Q-aaaa"), { origin: "http://127.0.0.1:9999", key: s.token, body }),
				],
				[
					"an inline frame holding the key",
					await s.call("POST", path("Q-aaaa"), { origin: "null", key: s.token, body }),
				],
				["an inline frame holding no key", await s.call("POST", path("Q-aaaa"), { origin: "null", body })],
				["an inline frame's preflight", await s.call("OPTIONS", path("Q-aaaa"), { origin: "null" })],
				["a GET", await s.call("GET", path("Q-aaaa"), { origin: ORIGIN, key: s.token })],
			];
			for (const [why, r] of refused) expect([why, r.status >= 400]).toEqual([why, true]);
			expect(refused.filter(([, r]) => r.status === 401).length).toBeGreaterThanOrEqual(3);
			expect(world(s.store)).toBe(before);
		});
		test(`${route}: works with the key from the page's own origin, and with the cookie a link granted`, async () => {
			const s = setup();
			askQuestion(s.store, question("Q-aaaa"));
			askQuestion(s.store, question("Q-bbbb"));
			if (route === "unsnooze") {
				await s.post("Q-aaaa", "snooze");
				await s.post("Q-bbbb", "snooze");
			}
			expect(
				(await s.call("POST", path("Q-aaaa"), { origin: ORIGIN, key: s.token, body: bodyFor(route) })).status,
			).toBe(200);
			const cookie = await cookieOf(s);
			expect(cookie).toContain("=");
			const viaCookie = await s.call("POST", path("Q-bbbb"), {
				origin: ORIGIN,
				body: bodyFor(route),
				headers: { cookie },
			});
			expect(viaCookie.status).toBe(200);
		});
	}

	test("an inline frame is still let in for what it always could: reads and a plain answer", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		askQuestion(s.store, question("Q-bbbb"));
		expect((await s.call("GET", "/api/queue", { origin: "null", key: s.token })).status).toBe(200);
		expect(
			(await s.call("POST", "/api/items/Q-aaaa/answer", { origin: "null", key: s.token, body: { choice: 0 } })).status,
		).toBe(200);
		// and its answer takes no more than a choice and a note: a direction's shape (a note, no choice) is refused to it
		const r = await s.call("POST", "/api/items/Q-bbbb/answer", {
			origin: "null",
			key: s.token,
			body: { note: "x", kind: "direction" },
		});
		expect(r.status).toBe(403);
		expect(s.store.claims.get(QUEUE, "Q-bbbb")).toBeUndefined();
	});

	test("the server's own list of what a frame may do names none of the four routes", () => {
		for (const route of ROUTES) {
			expect(inlineVerdict("POST", `/api/items/Q-abcd/${route}`)).toBe("refuse");
			expect(inlineVerdict("OPTIONS", `/api/items/Q-abcd/${route}`)).toBe("refuse");
			expect(inlineVerdict("GET", `/api/items/Q-abcd/${route}`)).toBe("refuse");
		}
		expect(inlineVerdict("POST", "/api/items/Q-abcd/answer")).toBe("answer");
	});
});

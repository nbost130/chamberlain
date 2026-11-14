/**
 * Snooze, un-snooze, direction and dismiss through the page's API: what each route does to the queue, the Steward's wake and the afk
 * hold, and who may call it. Each test drives the real handler (createApp) over a real store and, for who may call, a real capability.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendHeld, HELD, heldOpen } from "../core/afk.ts";
import { newToken, TOKEN_HEADER } from "../core/capability.ts";
import { reconcileItemHolds } from "../core/hold-reconcile.ts";
import { askQuestion, QUEUE, type Question, questionStates, readRelay } from "../core/questions.ts";
import { findSettled } from "../core/settled.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath, type Store } from "../core/store.ts";
import { memoryCapability } from "../testing/capability.ts";
import { createApp, inlineVerdict } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const ORIGIN = `http://${HOST}`;
const T0 = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Whether the ${id} billing retry runs hourly or daily`,
	context: "ctx",
	options: [{ label: "A · One" }, { label: "B · Two" }],
	recommended: 0,
	thread: "Billing thread",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-14T08:00:00.000Z",
	...over,
});
const ROUTES = ["snooze", "unsnooze", "direction", "dismiss"] as const;
const bodyFor = (route: string) =>
	route === "snooze" ? { until: iso(T0 + 2 * HOUR) } : route === "direction" ? { note: "go with A" } : {};

/** The page over a real capability and a clock the test moves. `root` rebuilds the page over the disk another setup left: a restart. */
function setup(opts: { root?: string; now?: { t: number }; sent?: string[] } = {}) {
	const root = opts.root ?? mkdtempSync(`${tmpdir()}/chamberlain-actions-`);
	if (!opts.root) dirs.push(root);
	const store = openStore(dbPath(`${root}/state`));
	const clock = opts.now ?? { t: T0 };
	const token = newToken();
	const cap = memoryCapability(token, { now: T0 });
	const logs: { event: string }[] = [];
	const app = createApp({
		capability: cap.capability,
		store,
		state: `${root}/state`,
		log: (event, data) => logs.push({ event, ...data }),
		hosts: [HOST],
		now: () => clock.t,
		sendToThread: async (server, threadId, message) => {
			opts.sent?.push(`${server}/${threadId}: ${message}`);
			return { ok: true, detail: "sent" };
		},
	});
	const call = (
		method: string,
		path: string,
		o: { origin?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
	) => {
		const headers: Record<string, string> = { host: HOST, ...(o.headers ?? {}) };
		if (o.origin) headers.origin = o.origin;
		if (o.key) headers[TOKEN_HEADER] = o.key;
		if (method === "POST") {
			headers["content-type"] ??= "application/json";
			headers["x-decision-queue"] ??= "1";
		}
		return app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers,
				...(method === "POST" ? { body: JSON.stringify(o.body ?? {}) } : {}),
			}),
		);
	};
	/** The full page: the key, from its own origin. */
	const page = (method: string, path: string, body?: unknown) =>
		call(method, path, { origin: ORIGIN, key: token, body });
	const post = (id: string, route: string, body?: unknown) =>
		page("POST", `/api/items/${id}/${route}`, body ?? bodyFor(route));
	const queue = async () =>
		(await (await page("GET", "/api/queue")).json()) as { items: { id: string }[]; snoozed: any[] };
	return { root, store, app, token, cap, clock, logs, call, page, post, queue };
}
type Setup = ReturnType<typeof setup>;

/** Everything the page could change: items, claims, relays, wakes, holds. A refused request leaves this identical. */
const world = (store: Store) =>
	JSON.stringify({
		items: store.items.list({ source: QUEUE }),
		claims: store.claims.list(QUEUE),
		wakes: store.wakes.rows("all"),
		held: store.items.list({ source: HELD }),
	});

const hold = (store: Store, id: string) =>
	appendHeld(store, { thread: "Billing thread", what: `waits on ${id}`, item: id }, new Date(T0 - HOUR));
const wakes = (s: Setup) => s.store.wakes.rows("all").map((r) => ({ id: r.deliveryId, message: r.message }));

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
		for (const until of [undefined, null, 7, "", "soon", iso(T0 - HOUR), iso(T0), iso(T0 + 400 * 24 * HOUR)]) {
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

	test("closes its afk hold, once the daemon's reconciler runs, as any answer does", async () => {
		const s = setup();
		askQuestion(s.store, question("Q-aaaa"));
		const h = hold(s.store, "Q-aaaa");
		await s.post("Q-aaaa", "direction", { note: "go" });
		expect(reconcileItemHolds(s.store, new Date(T0)).closed).toBe(1);
		expect(heldOpen(s.store)).toEqual([]);
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
		expect(reconcileItemHolds(s.store, new Date(T0)).closed).toBe(1);
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

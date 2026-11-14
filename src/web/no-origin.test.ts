/**
 * A key a post could carry never buys full authority. Two cases, both tested against the real handler (createApp) with a real capability:
 *   - the PAGE key in the `x-decision-token` header from a request with NO Origin (curl, an agent), or from a null-origin frame;
 *   - the VIEW key, the weak secret a Decisions post carries, from any origin or none.
 * Both get exactly what an inline frame gets: three reads and a plain answer (a choice and a note). Full authority is the signed cookie, a
 * same-origin request, or `?k=` on a page load.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOKEN_HEADER, newToken } from "../core/capability.ts";
import { askQuestion, getQuestion, readClaim, type Question } from "../core/questions.ts";
import { readRulings } from "../core/rulings.ts";
import { memoryCapability } from "../testing/capability.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const ORIGIN = `http://${HOST}`;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string, extra: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Question ${id}`,
	context: "x",
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	proposedRuling: "Lead with a photo",
	thread: "t",
	server: "main",
	createdAt: "2026-11-09T10:00:00.000Z",
	...extra,
});

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-noorigin-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	mkdirSync(`${root}/state/evidence/Q-evid`, { recursive: true });
	writeFileSync(`${root}/state/evidence/Q-evid/shot.png`, "PNGBYTES");
	const store = memStore();
	for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl", "Q-mnop", "Q-qrst"]) askQuestion(store, question(id));
	askQuestion(store, question("Q-evid", { evidence: [{ type: "image", path: "shot.png", caption: "a shot" }] }));
	const cardAnswers: unknown[] = [];
	const cards = [
		{
			id: "C-0123456789ab",
			type: "question" as const,
			server: "main",
			threadId: "t",
			threadTitle: "T",
			requestId: "r1",
			question: "Q?",
			options: [{ label: "A" }],
			answerable: true,
			sig: "s1",
		},
		{
			id: "C-ba9876543210",
			type: "approval" as const,
			server: "main",
			threadId: "t",
			threadTitle: "T",
			requestId: "r2",
			question: "Run it?",
			options: [{ label: "Approve once" }, { label: "Decline" }],
			answerable: true,
			sig: "s2",
			command: "rm -rf build",
		},
	];
	const logs: unknown[] = [];
	const page = newToken();
	const view = newToken();
	const cap = memoryCapability(page, { now: 1_800_000_000_000 }, view);
	const app = createApp({
		capability: cap.capability,
		store,
		state: `${root}/state`,
		log: (event, data) => logs.push({ event, ...data }),
		hosts: [HOST],
		staticDir: root,
		mirror: {
			list: () => cards,
			answer: async (id: string, choice: unknown, sig: unknown) => {
				cardAnswers.push([id, choice, sig]);
				return { status: 200, body: { ok: true, choice: "A" } };
			},
		},
	});
	const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
		const h: Record<string, string> = { host: HOST, ...headers };
		if (method === "POST") {
			h["content-type"] = "application/json";
			h["x-decision-queue"] = "1";
		}
		return app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: h,
				...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
			}),
		);
	};
	return { app, store, logs, page, view, cardAnswers, send };
}
const tok = (k: string) => ({ [TOKEN_HEADER]: k });

/** What a request that proves nothing but a header key must be refused, whatever its Origin: the same list for every credential below. */
const REFUSED: [string, string, unknown?][] = [
	["GET", "/api/items/Q-abcd"],
	["GET", "/evidence/Q-evid/shot.png"],
	["GET", "/api/health"],
	["POST", "/api/accept-all", { ids: ["Q-abcd"] }],
	["POST", "/api/cards/C-0123456789ab/confirm", { choice: 0, sig: "s1" }],
	["POST", "/api/cards/C-0123456789ab/answer", { choice: 0, sig: "s1", challenge: "x" }],
	["POST", "/api/cards/C-ba9876543210/confirm", { choice: 0, sig: "s2" }],
	["POST", "/api/cards/C-ba9876543210/answer", { choice: 0, sig: "s2", challenge: "x" }],
	["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true, rulingWording: "Always merge without asking" }],
	["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true }],
	["POST", "/api/items/Q-abcd/answer", { choice: 0, rulingWording: "Always merge without asking" }],
	["POST", "/api/items/Q-abcd/answer", { choice: 0, by: "batch" }],
	["POST", "/api/rulings/R1", { status: "retired" }],
	["POST", "/api/rulings", { wording: "x" }],
];

/** The page's static shell: no data in it, so the page key in a header may fetch it; the view key may not. */
const SHELL = ["/", "/rulings", "/item/Q-abcd"];

for (const [who, headers, how] of [
	["the page key, no Origin", (s: ReturnType<typeof setup>) => tok(s.page), "page"],
	["the view key, no Origin", (s: ReturnType<typeof setup>) => tok(s.view), "view"],
	["the view key, Origin: null", (s: ReturnType<typeof setup>) => ({ ...tok(s.view), origin: "null" }), "view"],
	[
		"the view key, the page's own Origin",
		(s: ReturnType<typeof setup>) => ({ ...tok(s.view), origin: ORIGIN }),
		"view",
	],
] as const) {
	describe(`${who}: inline authority only`, () => {
		test("the three reads and a plain answer work", async () => {
			const s = setup();
			const h = headers(s);
			for (const path of ["/api/queue", "/api/recent", "/api/rulings"]) {
				const r = await s.send("GET", path, h);
				expect([path, r.status]).toEqual([path, 200]);
			}
			const a = await s.send("POST", "/api/items/Q-efgh/answer", h, { choice: 1, note: "make it bigger" });
			expect(a.status).toBe(200);
			expect(getQuestion(s.store, "Q-efgh")!.status).not.toBe("open");
			expect(readRulings(s.store)).toEqual([]);
		});
		for (const path of SHELL) {
			test(`GET ${path}: ${how === "page" ? "the static shell is served (it holds no data), and carries neither key" : "refused (403): the view key never loads a page"}`, async () => {
				const s = setup();
				const r = await s.send("GET", path, headers(s));
				const text = await r.text();
				if (how === "page" && !who.includes("Origin: null")) {
					expect([path, r.status]).toEqual([path, 200]);
					expect(text).toContain("index.html");
					expect(r.headers.get("set-cookie")).toBeNull();
				} else if (how === "page") {
					expect([path, r.status]).toEqual([path, 200]); // a null-origin frame's own page-key request: unchanged
				} else expect([path, r.status]).toEqual([path, 403]);
				for (const k of [s.page, s.view]) expect(text.includes(k)).toBe(false);
			});
		}
		for (const [method, path, body] of REFUSED) {
			test(`${method} ${path}${body ? ` ${JSON.stringify(body).slice(0, 50)}` : ""} is refused (403), and nothing changes`, async () => {
				const s = setup();
				const r = await s.send(method, path, headers(s), body);
				// A null-origin frame never reached the page shell or evidence before this change (it got the static index or the file): only
				// the view key is refused those. The page key from a frame keeps behaving as it did.
				expect([method, path, r.status]).toEqual([method, path, 403]);
				const text = await r.text();
				expect(text).not.toContain("Question Q-");
				expect(text).not.toContain("PNGBYTES");
				expect(readRulings(s.store)).toEqual([]);
				expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
				expect(readClaim(s.store, "Q-abcd")).toBeUndefined();
				expect(s.cardAnswers).toEqual([]);
				await s.app.idle();
				expect(s.store.wakes.rows("all")).toEqual([]);
			});
		}
		test("its preflight: with no Origin it is refused and grants no CORS; from a null-origin frame it is the unchanged, grant-nothing 204", async () => {
			const s = setup();
			const r = await s.send("OPTIONS", "/api/queue", headers(s));
			if (who.includes("Origin: null")) {
				expect(r.status).toBe(204);
				expect(r.headers.get("access-control-allow-origin")).toBe("null");
			} else {
				expect(r.status).toBe(403);
				expect(r.headers.get("access-control-allow-origin")).toBeNull();
			}
		});
	});
}

describe("a key that is wrong, absent or the wrong kind", () => {
	test("no key: 401. A wrong key: 401. The view key is not the page key, and the page key is not the view key", async () => {
		const s = setup();
		expect((await s.send("GET", "/api/queue")).status).toBe(401);
		expect((await s.send("GET", "/api/queue", tok(`${s.view.slice(0, -1)}x`))).status).toBe(401);
		expect((await s.send("GET", "/api/queue", tok(s.view))).status).toBe(200);
		expect(s.app).toBeDefined();
		const only = memoryCapability(newToken(), undefined, undefined); // an install with no view key accepts none
		expect(only.capability.acceptsView(s.view)).toBe(false);
		expect(only.capability.acceptsView(undefined)).toBe(false);
		expect(only.capability.acceptsView("")).toBe(false);
		expect(s.page === s.view).toBe(false);
	});
	test("the view key is never a link, a cookie or a page load: `?k=<view>` on a page, evidence or the API is 401, and no cookie is set", async () => {
		const s = setup();
		for (const path of ["/", "/rulings", "/item/Q-abcd", "/evidence/Q-evid/shot.png", "/api/queue"]) {
			const r = await s.send("GET", `${path}?k=${encodeURIComponent(s.view)}`);
			expect([path, r.status]).toEqual([path, 401]);
			expect(r.headers.get("set-cookie")).toBeNull();
		}
	});
});

describe("full authority is still there for what earns it", () => {
	test("a ?k= link sets the cookie, and the cookie, or the page key from the page's own origin, saves a ruling and reads an item and its evidence", async () => {
		const s = setup();
		const link = await s.send("GET", `/?k=${encodeURIComponent(s.page)}`);
		expect(link.status).toBe(303);
		const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0]!;
		expect((await s.send("GET", "/api/items/Q-abcd", { cookie })).status).toBe(200);
		expect((await s.send("GET", "/", { cookie })).status).toBe(200);
		expect((await s.send("GET", "/evidence/Q-evid/shot.png", { cookie, "sec-fetch-site": "same-origin" })).status).toBe(
			200,
		);
		const same = { ...tok(s.page), origin: ORIGIN };
		expect((await s.send("GET", "/api/items/Q-efgh", same)).status).toBe(200);
		expect((await s.send("GET", "/evidence/Q-evid/shot.png", same)).status).toBe(200);
		const saved = await s.send("POST", "/api/items/Q-abcd/answer", same, {
			choice: 0,
			saveRuling: true,
			rulingWording: "Merge conflicts are the Steward's",
		});
		expect(saved.status).toBe(200);
		expect(readRulings(s.store)).toHaveLength(1);
		const viaCookie = await s.send(
			"POST",
			"/api/items/Q-ijkl/answer",
			{ cookie, origin: ORIGIN },
			{
				choice: 0,
				saveRuling: true,
				rulingWording: "Another one",
			},
		);
		expect(viaCookie.status).toBe(200);
	});
	test("a null-origin frame with the page key behaves exactly as before: three reads and a plain answer, a ruling field refused", async () => {
		const s = setup();
		const h = { ...tok(s.page), origin: "null" };
		for (const path of ["/api/queue", "/api/recent", "/api/rulings"])
			expect([path, (await s.send("GET", path, h)).status]).toEqual([path, 200]);
		expect((await s.send("GET", "/api/items/Q-abcd", h)).status).toBe(403);
		expect((await s.send("POST", "/api/items/Q-abcd/answer", h, { choice: 0, saveRuling: true })).status).toBe(403);
		expect((await s.send("POST", "/api/cards/C-0123456789ab/answer", h, { choice: 0, sig: "s1" })).status).toBe(403);
		expect((await s.send("POST", "/api/items/Q-qrst/answer", h, { choice: 1, note: "n" })).status).toBe(200);
	});
});

describe("a browser's navigation to the page keeps working", () => {
	test("GET / and the other page paths with the page cookie and no Origin (what a top-level navigation sends) are 200 with the app's html; the static assets need nothing", async () => {
		const s = setup();
		const link = await s.send("GET", `/?k=${encodeURIComponent(s.page)}`);
		expect(link.status).toBe(303);
		const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0]!;
		for (const path of ["/", "/rulings", "/item/Q-abcd"]) {
			const r = await s.send("GET", path, { cookie, "sec-fetch-mode": "navigate", "sec-fetch-site": "none" });
			expect([path, r.status]).toEqual([path, 200]);
			expect(r.headers.get("content-type")).toStartWith("text/html");
			expect(await r.text()).toContain("index.html");
		}
		for (const path of ["/app.js", "/app.css", "/inline.js"]) expect((await s.send("GET", path)).status).toBe(200);
		// and the same cookie reads the API from the page's own script (a same-origin fetch), while a header-only call is still inline authority
		expect((await s.send("GET", "/api/items/Q-abcd", { cookie, origin: ORIGIN })).status).toBe(200);
		expect((await s.send("GET", "/api/items/Q-abcd", tok(s.page))).status).toBe(403);
	});
});

describe("/open, a tap on a thread link, is a navigation GET like the page shell", () => {
	const open = "/open/main/mcp%3Alaunch%3Aab12";
	test("the page key in a header (no Origin, or its own) is let through to the route; the view key, and a null-origin frame, are refused and set no cookie", async () => {
		const s = setup();
		// no thread is configured here, so a request let through gets the route's own 404, never the 403 of the inline limit
		expect((await s.send("GET", open, tok(s.page))).status).toBe(404);
		expect((await s.send("GET", open, { ...tok(s.page), origin: ORIGIN })).status).toBe(404);
		for (const h of [tok(s.view), { ...tok(s.view), origin: "null" }, { ...tok(s.page), origin: "null" }]) {
			const r = await s.send("GET", open, h);
			expect(r.status).toBe(403);
			expect(r.headers.get("set-cookie")).toBeNull();
		}
		expect((await s.send("GET", `${open}?k=${encodeURIComponent(s.view)}`)).status).toBe(401);
	});
});

describe("secrecy", () => {
	test("neither key, raw or URL-encoded, is in a response body, a header or a logged event of any request above", async () => {
		const s = setup();
		const bodies: string[] = [];
		const heads: string[] = [];
		for (const h of [tok(s.page), tok(s.view), { ...tok(s.view), origin: "null" }, {}]) {
			for (const [m, p, b] of [
				["GET", "/api/queue"],
				["GET", "/api/items/Q-abcd"],
				["GET", "/evidence/Q-evid/shot.png"],
				["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true }],
				["POST", "/api/items/Q-mnop/answer", { choice: 0, note: "n" }],
			] as [string, string, unknown?][]) {
				const r = await s.send(m, p, h, b);
				bodies.push(await r.text());
				heads.push(JSON.stringify([...r.headers.entries()]));
			}
		}
		await s.app.idle();
		const everything = [...bodies, ...heads, JSON.stringify(s.logs), JSON.stringify(s.store.wakes.rows("all"))].join(
			"\n",
		);
		for (const k of [s.page, s.view])
			for (const form of [k, encodeURIComponent(k)]) expect(everything.includes(form)).toBe(false);
	});
});

/**
 * The capability token on the page: only a request that holds it, or a same-origin browser that opened a link carrying it, is served.
 * Each test drives the real handler (createApp) with a real capability over a token it can rotate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { COOKIE_MAX_AGE_S, newToken, TOKEN_HEADER } from "../core/capability.ts";
import { askQuestion, type Question } from "../core/questions.ts";
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

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-capweb-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const store = memStore();
	const item: Question = {
		id: "Q-abcd",
		kind: "product",
		title: "Pick one",
		context: "secret context",
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		thread: "t",
		server: "main",
		createdAt: "2026-11-09T10:00:00.000Z",
	};
	askQuestion(store, item);
	// a second question with a real evidence file, so that "served" means a file's bytes and not a 404
	mkdirSync(`${root}/state/evidence/Q-evid`, { recursive: true });
	writeFileSync(`${root}/state/evidence/Q-evid/shot.png`, "PNGBYTES");
	askQuestion(store, {
		...item,
		id: "Q-evid",
		title: "With a picture",
		evidence: [{ type: "image", path: "shot.png", caption: "a shot" }],
	});
	const logs: unknown[] = [];
	const token = newToken();
	const cap = memoryCapability(token, { now: 1_800_000_000_000 });
	const app = createApp({
		capability: cap.capability,
		store,
		state: `${root}/state`,
		log: (event, data) => logs.push({ event, ...data }),
		hosts: [HOST],
		staticDir: root,
	});
	const get = (path: string, headers: Record<string, string> = {}) =>
		app.fetch(new Request(`${ORIGIN}${path}`, { headers: { host: HOST, ...headers } }));
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1", ...headers },
				body: JSON.stringify(body),
			}),
		);
	return { app, store, logs, token, cap, get, post, item };
}
const key = (t: string) => ({ [TOKEN_HEADER]: t });
const cookieFrom = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("a request with no token is refused", () => {
	test("the API, an item's evidence and the page itself, whatever the method", async () => {
		const s = setup();
		for (const path of [
			"/api/queue",
			"/api/recent",
			"/api/rulings",
			"/api/items/Q-abcd",
			"/evidence/Q-abcd/shot.png",
		]) {
			const r = await s.get(path);
			expect(r.status, path).toBe(401);
			expect(await r.text(), path).not.toContain("secret context");
		}
		const page = await s.get("/");
		expect(page.status).toBe(401);
		expect(await page.text()).toContain("chamberlain web link"); // the static "needs its link" page, not the app
		expect((await s.get("/rulings")).status).toBe(401);
		expect((await s.get("/item/Q-abcd")).status).toBe(401);
		const answered = await s.post("/api/items/Q-abcd/answer", { choice: 1 });
		expect(answered.status).toBe(401);
		expect(s.store.items.get("question", "Q-abcd")?.status ?? "open").toBe("open");
		expect((await s.post("/api/accept-all", { ids: ["Q-abcd"] })).status).toBe(401);
	});
	test("but the page's own static code carries no data, and is served", async () => {
		const s = setup();
		for (const p of ["/inline.js", "/app.js", "/app.css"]) expect((await s.get(p)).status, p).toBe(200);
	});
});

describe("an item's evidence takes the cookie only from the page's own origin", () => {
	test("another port on the same host (same-site, not same-origin), another site and a request that says nothing are refused; the header and ?k= still work", async () => {
		const s = setup();
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		const img = "/evidence/Q-evid/shot.png";
		for (const site of ["same-site", "cross-site", "", undefined]) {
			const h: Record<string, string> = { cookie };
			if (site !== undefined) h["sec-fetch-site"] = site;
			expect((await s.get(img, h)).status, String(site)).toBe(401);
		}
		for (const site of ["same-origin", "none"])
			expect((await s.get(img, { cookie, "sec-fetch-site": site })).status, site).toBe(200);
		// an explicit token is not ambient authority: it works whatever the site, from the page's own origin (a header with no Origin is
		// inline authority only, which never reads evidence: see "a request with only a header")
		expect((await s.get(img, { "sec-fetch-site": "cross-site", origin: ORIGIN, ...key(s.token) })).status).toBe(200);
		expect((await s.get(`${img}?k=${s.token}`, { "sec-fetch-site": "same-site" })).status).toBe(200);
		// and the cookie's use for the API and the page is unchanged
		expect((await s.get("/api/queue", { cookie, "sec-fetch-site": "same-site" })).status).toBe(200);
	});
});

describe("the refusal is plain text, not JSON", () => {
	test("so a frame still running the previous build's script, which reads every reply as JSON, fails loudly and does not show an empty queue", async () => {
		const s = setup();
		const r = await s.get("/api/queue", { origin: "null" });
		expect(r.status).toBe(401);
		expect(r.headers.get("content-type")).toStartWith("text/plain");
		const body = await r.text();
		expect(body).toContain("chamberlain web link");
		expect(() => JSON.parse(body)).toThrow();
	});
});

describe("a bad token is refused", () => {
	test("in the header, in a link, and in a cookie", async () => {
		const s = setup();
		const bad = `${s.token.slice(0, -1)}${s.token.endsWith("A") ? "B" : "A"}`;
		expect((await s.get("/api/queue", key(bad))).status).toBe(401);
		expect((await s.get("/api/queue", key(""))).status).toBe(401);
		expect((await s.get(`/?k=${bad}`)).status).toBe(401);
		expect((await s.get(`/?k=`)).status).toBe(401);
		expect((await s.get(`/evidence/Q-abcd/x?k=${bad}`)).status).toBe(401);
		expect((await s.get("/api/queue", { cookie: `dq_cap=v1.9999999999.${"0".repeat(64)}` })).status).toBe(401);
		expect((await s.get("/api/queue", { cookie: "dq_cap=garbage" })).status).toBe(401);
	});
});

describe("a good token is served", () => {
	test("in the header: the API answers, and the key is not echoed back", async () => {
		const s = setup();
		const r = await s.get("/api/queue", key(s.token));
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(text).toContain("Q-abcd");
		expect(text).not.toContain(s.token);
		// the page itself, and an answer, from the page's own origin; with no Origin the header buys inline authority only
		expect((await s.get("/", { origin: ORIGIN, ...key(s.token) })).status).toBe(200);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 1 }, key(s.token))).status).toBe(200);
	});
	test("in a link: the page load sets a signed cookie, drops the key from the address, and the cookie then serves the page and the API", async () => {
		const s = setup();
		const link = await s.app.fetch(
			new Request(`${ORIGIN}/rulings?a=1&k=${s.token}`, { headers: { host: HOST }, redirect: "manual" }),
		);
		expect(link.status).toBe(303);
		expect(link.headers.get("location")).toBe("/rulings?a=1");
		expect(link.headers.get("location")).not.toContain(s.token);
		const setCookie = link.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain(`Max-Age=${COOKIE_MAX_AGE_S}`);
		expect(setCookie).not.toContain(s.token); // signed, and carries no token
		const cookie = cookieFrom(link);
		expect((await s.get("/rulings", { cookie })).status).toBe(200);
		expect((await s.get("/", { cookie })).status).toBe(200);
		expect((await s.get("/api/queue", { cookie })).status).toBe(200);
		expect((await s.get("/evidence/Q-abcd/none.png", { cookie, "sec-fetch-site": "same-origin" })).status).toBe(404); // authorised, and there is no such file
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 }, { cookie, origin: ORIGIN })).status).toBe(200);
	});
	test("an <img> may carry the key as ?k= (a header is not possible there), and the evidence file's bytes come back; without it they do not", async () => {
		const s = setup();
		const img = await s.get(`/evidence/Q-evid/shot.png?k=${s.token}`);
		expect(img.status).toBe(200);
		expect(await img.text()).toBe("PNGBYTES");
		expect((await s.get("/evidence/Q-evid/shot.png")).status).toBe(401);
		expect((await s.get("/evidence/Q-evid/shot.png", { origin: ORIGIN, ...key(s.token) })).status).toBe(200);
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		expect(await (await s.get("/evidence/Q-evid/shot.png", { cookie, "sec-fetch-site": "same-origin" })).text()).toBe(
			"PNGBYTES",
		);
		expect((await s.get(`/api/queue?k=${s.token}`)).status).toBe(401); // never for the API
	});
	test("the cookie lasts a year and a bit, then is refused", async () => {
		const s = setup();
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		s.cap.clock.now += (COOKIE_MAX_AGE_S - 60) * 1000;
		expect((await s.get("/api/queue", { cookie })).status).toBe(200);
		s.cap.clock.now += 120 * 1000;
		expect((await s.get("/api/queue", { cookie })).status).toBe(401);
	});
});

describe("a null origin (T3's sandboxed frame)", () => {
	test("without a token is refused, and can read why", async () => {
		const s = setup();
		const r = await s.get("/api/queue", { origin: "null" });
		expect(r.status).toBe(401);
		expect(r.headers.get("access-control-allow-origin")).toBe("null"); // so the frame can show "your key no longer works"
		expect(await r.text()).not.toContain("Q-abcd");
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 1 }, { origin: "null" })).status).toBe(401);
		expect(s.store.items.get("question", "Q-abcd")?.status ?? "open").toBe("open");
	});
	test("with a bad token is refused", async () => {
		const s = setup();
		expect((await s.get("/api/queue", { origin: "null", ...key("not-it") })).status).toBe(401);
	});
	test("with the token reads the queue and answers, and nothing beyond what an inline frame may do", async () => {
		const s = setup();
		const read = await s.get("/api/queue", { origin: "null", ...key(s.token) });
		expect(read.status).toBe(200);
		expect(read.headers.get("access-control-allow-origin")).toBe("null");
		expect((await s.get("/api/rulings", { origin: "null", ...key(s.token) })).status).toBe(200);
		// still refused with the token: one item's own read, a ruling change, a batch accept
		expect((await s.get("/api/items/Q-abcd", { origin: "null", ...key(s.token) })).status).toBe(403);
		expect((await s.post("/api/rulings/R1/retire", {}, { origin: "null", ...key(s.token) })).status).toBe(403);
		expect((await s.post("/api/accept-all", { ids: ["Q-abcd"] }, { origin: "null", ...key(s.token) })).status).toBe(
			403,
		);
		const ans = await s.post("/api/items/Q-abcd/answer", { choice: 1 }, { origin: "null", ...key(s.token) });
		expect(ans.status).toBe(200);
	});
	test("a cookie does not stand in for the token, and the key in the address does not either", async () => {
		const s = setup();
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		expect((await s.get("/api/queue", { origin: "null", cookie })).status).toBe(401);
		expect((await s.get(`/api/queue?k=${s.token}`, { origin: "null" })).status).toBe(401);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 1 }, { origin: "null", cookie })).status).toBe(401);
	});
	test("the preflight is answered (it cannot carry the token) and grants nothing by itself", async () => {
		const s = setup();
		const pre = await s.app.fetch(
			new Request(`${ORIGIN}/api/queue`, { method: "OPTIONS", headers: { host: HOST, origin: "null" } }),
		);
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-headers")).toContain(TOKEN_HEADER);
	});
});

describe("any other origin is refused, token or not", () => {
	test("a page elsewhere, with the header, with a cookie, and a cross-site POST", async () => {
		const s = setup();
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		for (const origin of ["https://evil.example", "http://127.0.0.1:9999", "http://attacker.test"]) {
			expect((await s.get("/api/queue", { origin, ...key(s.token) })).status, origin).toBe(403);
			expect((await s.get("/api/queue", { origin, cookie })).status, origin).toBe(403);
			expect((await s.get("/", { origin, cookie })).status, origin).toBe(403);
			expect(
				(await s.post("/api/items/Q-abcd/answer", { choice: 1 }, { origin, ...key(s.token) })).status,
				origin,
			).toBe(403);
		}
		expect(s.store.items.get("question", "Q-abcd")?.status ?? "open").toBe("open");
	});
	test("the page's own origin, with its cookie, is served", async () => {
		const s = setup();
		const cookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		expect((await s.get("/api/queue", { origin: ORIGIN, cookie })).status).toBe(200);
	});
	test("an unknown Host is still refused first", async () => {
		const s = setup();
		const r = await s.app.fetch(
			new Request(`${ORIGIN}/api/queue`, { headers: { host: "evil.example", ...key(s.token) } }),
		);
		expect(r.status).toBe(421);
	});
});

describe("rotation ends every old link", () => {
	test("the old header, link, cookie and rendered view stop at once; the new token works without a restart", async () => {
		const s = setup();
		const oldCookie = cookieFrom(
			await s.app.fetch(new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" })),
		);
		expect((await s.get("/api/queue", key(s.token))).status).toBe(200);
		expect((await s.get("/api/queue", { cookie: oldCookie })).status).toBe(200);
		const old = s.token;
		const fresh = newToken();
		s.cap.state.token = fresh; // `chamberlain web rotate-token` replaced the file
		expect((await s.get("/api/queue", key(old))).status).toBe(401);
		expect((await s.get("/api/queue", { origin: "null", ...key(old) })).status).toBe(401);
		expect((await s.get(`/?k=${old}`)).status).toBe(401);
		expect((await s.get("/api/queue", { cookie: oldCookie })).status).toBe(401);
		expect((await s.get("/api/queue", key(fresh))).status).toBe(200);
		expect((await s.get(`/?k=${fresh}`)).status).toBe(303);
	});
});

describe("the token is never logged", () => {
	test("not in the page's log, not in the events table, not in any response or header, across every case", async () => {
		const s = setup();
		const seen: string[] = [];
		const watch = async (r: Response) => {
			seen.push(JSON.stringify([...r.headers.entries()]), await r.text());
			return r;
		};
		const bad = "wrong-token-value-0123456789abcdefghij";
		for (const [path, h] of [
			["/api/queue", key(s.token)],
			["/api/queue", key(bad)],
			["/api/queue", {}],
			[`/?k=${bad}`, {}],
			["/api/queue", { origin: "null", ...key(s.token) }],
			["/api/queue", { origin: "https://evil.example", ...key(s.token) }],
		] as [string, Record<string, string>][])
			await watch(await s.get(path, h));
		const link = await s.app.fetch(
			new Request(`${ORIGIN}/?k=${s.token}`, { headers: { host: HOST }, redirect: "manual" }),
		);
		seen.push(link.headers.get("location") ?? "");
		await s.post("/api/items/Q-abcd/answer", { choice: 1 }, key(s.token));
		await s.app.idle();
		const everything = JSON.stringify([s.logs, s.store.events.query({}), seen]);
		expect(everything).not.toContain(s.token);
		expect(everything).not.toContain(bad);
	});
});

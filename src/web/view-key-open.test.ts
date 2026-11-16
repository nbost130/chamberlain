/**
 * The one navigation the VIEW key may make: `GET /open/<server>/<threadId>`, the Decisions view's "Open the thread" link (./view-key.ts). It carries
 * the view key as `?k=` (a new tab sends no header), is answered exactly as the page key's is (a tap, `Sec-Fetch-User: ?1`, gets a 303 to the
 * thread's link; anything else the open page), and does nothing else: it signs no browser in, sets no cookie, and never reaches another route.
 */

import { describe, expect, test } from "bun:test";
import { newToken } from "../core/ops/capability.ts";
import { useWebViewKeyFixtures } from "../testing/web-view-key-fixtures.ts";
import type { Linker } from "./thread-links.ts";
import { viewKeyVerdict } from "./view-key.ts";

const { ORIGIN, setup, tok, REFUSED } = useWebViewKeyFixtures();

const TARGET = "t3code://threads/env-home/t1";
/** A linker with one thread: the target comes from the path alone, as the real one makes it (./thread-links.ts). */
const links: Linker = {
	link: () => undefined,
	target: (server, id) => (server === "mithrandir" && id === "t1" ? TARGET : undefined),
	openPath: () => undefined,
	appLink: () => undefined,
};
const OPEN = "/open/mithrandir/t1";
const TAP = { "sec-fetch-user": "?1" };

const viaLink = (s: { view: string }, path = OPEN) => `${path}?k=${encodeURIComponent(s.view)}`;

describe("the verdict", () => {
	test("GET on a well-formed /open path is `open`; every other method, and a path of any other shape, is refused", () => {
		expect(viewKeyVerdict("GET", OPEN)).toBe("open");
		expect(viewKeyVerdict("GET", "/open/mac/mcp%3Alaunch%3Aab12")).toBe("open");
		for (const [m, p] of [
			["POST", OPEN],
			["PUT", OPEN],
			["DELETE", OPEN],
			["OPTIONS", OPEN],
			["GET", "/open"],
			["GET", "/open/mithrandir"],
			["GET", "/open/mithrandir/"],
			["GET", "/open/mithrandir/t1/extra"],
			["GET", "/open//t1"],
			["GET", "/opened/mithrandir/t1"],
		] as const)
			expect([m, p, viewKeyVerdict(m, p)]).toEqual([m, p, "refuse"]);
	});
});

describe("GET /open with the view key", () => {
	for (const [how, send] of [
		["?k= (a link opened in a new tab)", (s: ReturnType<typeof setup>, h = {}) => s.send("GET", viaLink(s), h)],
		["the header, no Origin", (s: ReturnType<typeof setup>, h = {}) => s.send("GET", OPEN, { ...tok(s.view), ...h })],
	] as const) {
		describe(how, () => {
			test("a tap gets a 303 straight to the linker's target, with no cookie and no key in the reply", async () => {
				const s = setup(links);
				const r = await send(s, TAP);
				expect([r.status, r.headers.get("location"), r.headers.get("set-cookie")]).toEqual([303, TARGET, null]);
				expect(JSON.stringify([...r.headers.entries()]).includes(s.view)).toBe(false);
			});
			test("anything else gets the open page, with the target and no cookie and no key in it", async () => {
				const s = setup(links);
				const r = await send(s);
				const text = await r.text();
				expect([r.status, r.headers.get("content-type"), r.headers.get("set-cookie")]).toEqual([
					200,
					"text/html; charset=utf-8",
					null,
				]);
				expect(text).toContain(TARGET);
				expect([s.view, s.page].some((k) => text.includes(k))).toBe(false);
			});
		});
	}

	test("it is answered as the page key is: the same target for a tap, the same page for a load", async () => {
		const s = setup(links);
		const page = await s.send("GET", OPEN, { ...tok(s.page), ...TAP });
		const view = await s.send("GET", viaLink(s), TAP);
		expect([view.status, view.headers.get("location")]).toEqual([page.status, page.headers.get("location")]);
		const pageLoad = await s.send("GET", OPEN, tok(s.page));
		const viewLoad = await s.send("GET", viaLink(s));
		expect(await viewLoad.text()).toBe(await pageLoad.text());
	});

	test("the target is made from the path alone: a target, redirect or key in the query is ignored, and an unknown thread is the route's own 404", async () => {
		const s = setup(links);
		const q = `k=${encodeURIComponent(s.view)}&target=https%3A%2F%2Fevil.example%2F&next=https%3A%2F%2Fevil.example%2F`;
		const r = await s.send("GET", `${OPEN}?${q}`, TAP);
		expect([r.status, r.headers.get("location")]).toEqual([303, TARGET]);
		for (const p of ["/open/mithrandir/other", "/open/elsewhere/t1"]) {
			const miss = await s.send("GET", viaLink(s, p), TAP);
			const asPage = await s.send("GET", p, { ...tok(s.page), ...TAP });
			expect([p, miss.status, asPage.status]).toEqual([p, 404, 404]);
		}
	});

	test("it does not sign the browser in: no cookie is set, and the same browser's next request, with no key, is locked", async () => {
		const s = setup(links);
		for (const h of [{}, TAP]) {
			const r = await s.send("GET", viaLink(s), h);
			expect(r.headers.get("set-cookie")).toBeNull();
			expect(r.status).toBe(h === TAP ? 303 : 200);
		}
		expect((await s.send("GET", OPEN, TAP)).status).toBe(401);
		expect((await s.send("GET", "/api/queue")).status).toBe(401);
		// the view key is not a cookie either: sent as one it proves nothing
		expect((await s.send("GET", OPEN, { cookie: `dq_cap=${s.view}` })).status).toBe(401);
		// the page key by `?k=` is still the link that signs in, as before
		const signIn = await s.send("GET", `${OPEN}?k=${encodeURIComponent(s.page)}`, TAP);
		expect([signIn.status, signIn.headers.get("location")]).toEqual([303, TARGET]);
		expect(signIn.headers.get("set-cookie")).toContain("dq_cap=");
	});

	test("a wrong key, and a key of no kind, are locked (401)", async () => {
		const s = setup(links);
		expect((await s.send("GET", `${OPEN}?k=${encodeURIComponent(newToken())}`, TAP)).status).toBe(401);
		expect((await s.send("GET", `${OPEN}?k=`, TAP)).status).toBe(401);
		expect((await s.send("GET", OPEN, TAP)).status).toBe(401);
	});

	test("a null-origin frame is refused it, by `?k=` and by the header, as the page key is", async () => {
		const s = setup(links);
		const frame = { origin: "null", ...TAP };
		const a = await s.send("GET", viaLink(s), frame);
		const b = await s.send("GET", OPEN, { ...tok(s.view), ...frame });
		const c = await s.send("GET", OPEN, { ...tok(s.page), ...frame });
		expect([a.status, b.status, c.status]).toEqual([401, 403, 403]);
		for (const r of [a, b, c]) expect(r.headers.get("set-cookie")).toBeNull();
	});

	test("the page's own Origin is let through, as it is for the page key", async () => {
		const s = setup(links);
		const r = await s.send("GET", viaLink(s), { origin: ORIGIN, ...TAP });
		expect([r.status, r.headers.get("location")]).toEqual([303, TARGET]);
	});
});

describe("the view key can do nothing else with /open", () => {
	test("a method other than GET is refused, by the header (403) and by `?k=` (401), and sends nowhere", async () => {
		const s = setup(links);
		for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
			for (const [how, path, h] of [
				["header", OPEN, tok(s.view)],
				["?k=", viaLink(s), {}],
			] as const) {
				const r = await s.send(m, path, h, {});
				expect([m, how, [401, 403, 404, 405].includes(r.status), r.headers.get("location")]).toEqual([
					m,
					how,
					true,
					null,
				]);
				expect([m, how, r.status === 303 || r.status === 200]).toEqual([m, how, false]);
			}
		}
		const preflight = await s.send("OPTIONS", OPEN, { origin: "null" });
		expect(preflight.status).toBe(403);
	});

	test("a malformed /open path is answered exactly as it is to the page key: refused or 404, never a redirect", async () => {
		const s = setup(links);
		const paths = [
			"/open",
			"/open/",
			"/open/mithrandir",
			"/open/mithrandir/",
			"/open/mithrandir/t1/extra",
			"/open//t1",
			"/open/%E0%A4/t1",
		];
		for (const p of paths) {
			const asView = await s.send("GET", viaLink(s, p), TAP);
			const asViewHeader = await s.send("GET", p, { ...tok(s.view), ...TAP });
			const asPage = await s.send("GET", p, { ...tok(s.page), ...TAP });
			// a path that is not an /open route is the key gate's 401 by `?k=` and the allowlist's 403 by the header, as it was; a malformed
			// escape inside a well-formed path is the route's own 400, the same one the page key gets
			const wellFormed = viewKeyVerdict("GET", p) === "open";
			expect([p, asView.status, asViewHeader.status]).toEqual(
				wellFormed ? [p, asPage.status, asPage.status] : [p, 401, 403],
			);
			for (const r of [asView, asViewHeader])
				expect([p, r.status === 303, r.headers.get("set-cookie")]).toEqual([p, false, null]);
		}
	});

	test("`?k=<view key>` still opens no other route: a page, an item and the API stay refused, and set no cookie (evidence: view-key-evidence.test.ts)", async () => {
		const s = setup(links);
		for (const p of ["/", "/rulings", "/item/Q-abcd", "/api/items/Q-abcd", "/api/queue", "/api/health"]) {
			const r = await s.send("GET", viaLink(s, p), TAP);
			expect([p, r.status, r.headers.get("set-cookie")]).toEqual([p, 401, null]);
		}
	});

	test("every route the view key refused before still refuses it (the list in the fixtures), whatever origin", async () => {
		const s = setup(links);
		for (const origin of [{}, { origin: "null" }, { origin: ORIGIN }] as Record<string, string>[]) {
			for (const [method, path, body] of REFUSED) {
				const r = await s.send(method, path, { ...tok(s.view), ...origin }, body);
				expect([method, path, [401, 403].includes(r.status), r.headers.get("set-cookie")]).toEqual([
					method,
					path,
					true,
					null,
				]);
			}
		}
	});

	test("the Decisions view's own calls still work beside it: the key that opens a thread still reads the queue", async () => {
		const s = setup(links);
		expect((await s.send("GET", "/api/queue", tok(s.view))).status).toBe(200);
		expect((await s.send("GET", viaLink(s), TAP)).status).toBe(303);
	});
});

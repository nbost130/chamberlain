/** thread-links, continued: see thread-links.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import type { Question } from "../core/items/questions.ts";
import { useWebThreadLinksFixtures } from "../testing/web-thread-links-fixtures.ts";

const { SERVERS, T1, T2, LAUNCHED, LAUNCHED_PATH, ORIGIN, page } = useWebThreadLinksFixtures();

describe("the page", () => {
	test("the queue gives every card with a thread its link and its /open path; a server it can't link gets neither", async () => {
		const { token, get } = page();
		const q = (await (await get("/api/queue", { "x-decision-token": token })).json()) as any;
		const plain = q.items.find((i: any) => i.id === "Q-abcd");
		expect(plain.link).toBe(`t3-thread://v2/env-home/${T1}`);
		expect(plain.open).toBe(`/open/mithrandir/${T1}`);
		const gone = q.items.find((i: any) => i.id === "Q-efgh");
		expect(gone.link).toBeUndefined();
		expect(gone.open).toBeUndefined();
		expect(q.cards[0].open).toBe(`/open/mac/${LAUNCHED_PATH}`);
		expect(q.cards[0].link).toBe(`t3-thread://v2/env-mac/${LAUNCHED}`);
	});
	test("/open with ?k= signs the browser in and drops the key; then it sends the device on to the app link", async () => {
		const { token, get } = page();
		const r = await get(`/open/mac/${LAUNCHED_PATH}?k=${token}`);
		expect(r.status).toBe(303);
		expect(r.headers.get("location")).toBe(`/open/mac/${LAUNCHED_PATH}`);
		const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
		const o = await get(`/open/mac/${LAUNCHED_PATH}`, { cookie });
		expect(o.status).toBe(200);
		const html = await o.text();
		expect(html).toContain(`http-equiv="refresh" content="0;url=t3code://threads/env-mac/${LAUNCHED}"`);
		expect(html).toContain(`href="t3code://threads/env-mac/${LAUNCHED}"`);
		expect(html).toContain("Build it");
		expect(o.headers.get("content-security-policy")).toContain("script-src 'self'");
	});
	test("/open needs the key, and gives no page for a thread it cannot link", async () => {
		const { token, get } = page();
		// the page key from the page's own origin: a bare header with no Origin is inline authority, which never reaches /open
		const auth = { "x-decision-token": token, origin: ORIGIN };
		expect((await get(`/open/mac/${T1}`)).status).toBe(401);
		// a tap is a navigation GET: the page key in a header (no Origin) is served it, as it is the page's shell; the view key never is
		expect((await get(`/open/mac/${T1}`, { "x-decision-token": token })).status).toBe(200);
		// a null-origin frame holding the page key is inline authority, and /open is not on its list
		expect((await get(`/open/mac/${T1}`, { "x-decision-token": token, origin: "null" })).status).toBe(403);
		expect((await get(`/open/laptop-gone/${T2}`, auth)).status).toBe(404);
		expect((await get(`/open/mac/${T1}`, auth)).status).toBe(200);
		expect((await get("/open/mac/%E0%A4%A", auth)).status).toBe(400);
	});
	test("/open gives 404 for every thread id shape T3 does not issue", async () => {
		const { token, get } = page();
		// the page key from the page's own origin: a bare header with no Origin is inline authority, which never reaches /open
		const auth = { "x-decision-token": token, origin: ORIGIN };
		for (const bad of ["mcp%3Alaunch%3ANOTHEX", "garbage", "%3A", "a%2Fb", "t1", `mcp%3Alaunch%3A${"ab".repeat(31)}`])
			expect([bad, (await get(`/open/mac/${bad}`, auth)).status]).toEqual([bad, 404]);
	});
	test("the queue gives each card the app link a view in T3's phone app opens, where the target is one", async () => {
		const { token, get } = page();
		const q = (await (await get("/api/queue", { "x-decision-token": token })).json()) as any;
		expect(q.items.find((i: any) => i.id === "Q-abcd").app).toBe(`t3code://threads/env-home/${T1}`);
		expect(q.items.find((i: any) => i.id === "Q-efgh").app).toBeUndefined();
		expect(q.cards[0].app).toBe(`t3code://threads/env-mac/${LAUNCHED}`);
	});
	test("a tapped /open goes straight to the app: one 303 to the app link, no page in between", async () => {
		const { token, get } = page();
		const r = await get(`/open/mac/${LAUNCHED_PATH}`, { "x-decision-token": token, "sec-fetch-user": "?1" });
		expect(r.status).toBe(303);
		expect(r.headers.get("location")).toBe(`t3code://threads/env-mac/${LAUNCHED}`);
		expect(r.headers.get("cache-control")).toBe("no-store");
		expect(await r.text()).toBe("");
	});
	test("a tapped /open with ?k= signs in and goes straight to the app; the key is in neither the Location nor a body", async () => {
		const { token, get } = page();
		const r = await get(`/open/mac/${LAUNCHED_PATH}?k=${token}`, { "sec-fetch-user": "?1" });
		expect(r.status).toBe(303);
		expect(r.headers.get("location")).toBe(`t3code://threads/env-mac/${LAUNCHED}`);
		expect(r.headers.get("location")).not.toContain(token);
		expect(r.headers.get("set-cookie")).toBeTruthy();
		expect(await r.text()).not.toContain(token);
	});
	test("a load that is not a tap gets the page (it goes on by itself, and has a button), never a redirect", async () => {
		const { token, get } = page();
		for (const h of [{}, { "sec-fetch-user": "?0" }, { "sec-fetch-user": "1" }, { "sec-fetch-user": "?1?1" }] as Record<
			string,
			string
		>[]) {
			const r = await get(`/open/mac/${T1}`, { "x-decision-token": token, ...h });
			expect([h, r.status]).toEqual([h, 200]);
			const html = await r.text();
			expect(html).toContain(`content="0;url=t3code://threads/env-mac/${T1}"`);
			expect(html).toContain("Nothing opened? Tap the button");
			expect(html).not.toContain(token);
		}
	});
	test("a tap never redirects off a thread the page cannot link, or to a target the request names", async () => {
		const { token, get } = page();
		const tap = { "x-decision-token": token, "sec-fetch-user": "?1" };
		expect((await get(`/open/laptop-gone/${T2}`, tap)).status).toBe(404);
		expect((await get("/open/mac/garbage", tap)).status).toBe(404);
		expect((await get("/open/mac/%E0%A4%A", tap)).status).toBe(400);
		expect((await get(`/open/mac/${T1}`, { "sec-fetch-user": "?1" })).status).toBe(401);
		const r = await get(`/open/mac/${T1}?to=https://evil.example&location=javascript:alert(1)`, tap);
		expect(r.headers.get("location")).toBe(`t3code://threads/env-mac/${T1}`);
		// With ?k= on a thread it cannot link, the tap only signs in and goes to the key-less address, which then says 404.
		const k = await get(`/open/mac/garbage?k=${token}`, { "sec-fetch-user": "?1" });
		expect(k.status).toBe(303);
		expect(k.headers.get("location")).toBe("/open/mac/garbage");
	});
	test("a secret question carries whether its thread's secret box is still open; nothing else asks", async () => {
		const asked: unknown[] = [];
		const secret: Question = {
			id: "Q-sec1",
			kind: "only-you",
			title: "Paste the read-only token",
			context: "c",
			options: [],
			thread: "Mobile app",
			server: "mithrandir",
			threadId: T1,
			secret: true,
			createdAt: "2026-11-09T10:00:00.000Z",
		};
		const { token, get } = page(
			SERVERS,
			(q) => {
				asked.push(q);
				return "ended";
			},
			[secret],
		);
		const q = (await (await get("/api/queue", { "x-decision-token": token })).json()) as any;
		expect(q.items.find((i: any) => i.id === "Q-sec1").secretRequest).toBe("ended");
		expect(q.items.find((i: any) => i.id === "Q-abcd").secretRequest).toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ id: "Q-sec1", server: "mithrandir", threadId: T1 });
	});
	test("/open goes only where the linker says: a target in the query is ignored", async () => {
		const { token, get } = page();
		const html = await (
			await get(`/open/mac/${T1}?to=https://evil.example`, { "x-decision-token": token, origin: ORIGIN })
		).text();
		expect(html).toContain(`t3code://threads/env-mac/${T1}`);
		expect(html).not.toContain("evil.example");
	});
});

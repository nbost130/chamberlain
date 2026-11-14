/**
 * A card's thread link and the page's `/open/<server>/<threadId>` route (./thread-links.ts): which link each server gets, which
 * config overrides it, and that the route sends a device only to a link it made itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { t3Linker } from "../adapters/t3/links.ts";
import type { Adapter, WaitingCard } from "../core/adapter.ts";
import { newToken } from "../core/capability.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { memoryCapability } from "../testing/capability.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import { createLinker, isAppLink, openPage } from "./thread-links.ts";
import type { ServerAdapter } from "./waiting.ts";

/** A T3-shaped adapter over the real link builder: only `threadLinks`, which is all the linker reads. */
const t3 = (name: string, entry: Record<string, unknown>): ServerAdapter => {
	const l = t3Linker({ origin: `http://${name}:3773`, ...entry }, { read: async () => undefined });
	return {
		server: { name, adapter: "t3", ...entry },
		adapter: { id: "t3", capabilities: ["threadLinks"], threadLinks: l.links } as unknown as Adapter,
	};
};
/** The live layout: a home server with no environmentId (its id given for links), and two linked servers. */
const SERVERS = [
	t3("mithrandir", { linkEnvironmentId: "env-home" }),
	t3("mac", { environmentId: "env-mac" }),
	t3("omar", { environmentId: "env-omar" }),
];

const T1 = "11111111-2222-3333-4444-555555555555";
const T2 = "66666666-7777-8888-9999-000000000000";
const LAUNCHED = `mcp:launch:${"ab12".repeat(16)}`;
const LAUNCHED_PATH = encodeURIComponent(LAUNCHED);

describe("createLinker", () => {
	const linker = createLinker({ servers: () => SERVERS });
	test("each server's link names its own environment", () => {
		expect(linker.link("mithrandir", T1)).toBe(`t3-thread://v2/env-home/${T1}`);
		expect(linker.link("mac", LAUNCHED)).toBe(`t3-thread://v2/env-mac/${LAUNCHED}`);
		expect(linker.link("omar", T2)).toBe(`t3-thread://v2/env-omar/${T2}`);
	});
	test("/open sends a device to the app link, which a phone opens in T3 Code", () => {
		expect(linker.target("mac", T1)).toBe(`t3code://threads/env-mac/${T1}`);
		expect(linker.openPath("mac", LAUNCHED)).toBe(`/open/mac/${LAUNCHED_PATH}`);
	});
	test("a home server whose environment is not known yet has no link and no /open path, never a broken one", () => {
		const l = createLinker({ servers: () => [t3("mithrandir", {})] });
		expect(l.link("mithrandir", T1)).toBeUndefined();
		expect(l.target("mithrandir", T1)).toBeUndefined();
		expect(l.openPath("mithrandir", T1)).toBeUndefined();
	});
	test("an unknown server or an adapter without threadLinks and no prefix gives nothing", () => {
		const thin = { server: { name: "thin", adapter: "fake" }, adapter: createFakeAdapter({ capabilities: [] }) };
		const l = createLinker({ servers: () => [...SERVERS, thin] });
		expect(l.link("nowhere", T1)).toBeUndefined();
		expect(l.openPath("thin", T1)).toBeUndefined();
		expect(l.link("__proto__", T1)).toBeUndefined();
	});
	test("a thread id T3 does not issue gets nothing, not even from a config prefix", () => {
		const l = createLinker({
			servers: () => SERVERS,
			threadLinks: { mac: "https://t3.example/m/" },
			mirrorLinks: { mac: "https://t3.example/m/" },
		});
		for (const bad of [
			"garbage",
			":",
			"a/b",
			"has space",
			"",
			"x\u0000",
			"mcp:launch:NOTHEX",
			`mcp:launch:${"ab".repeat(31)}`,
		]) {
			expect([bad, l.link("mac", bad), l.target("mac", bad), l.openPath("mac", bad)]).toEqual([
				bad,
				undefined,
				undefined,
				undefined,
			]);
		}
	});
	test("a config prefix for a server that is not in `servers` links nothing", () => {
		const l = createLinker({
			servers: () => [],
			threadLinks: { gone: "https://removed.example/t/" },
			mirrorLinks: { gone: "https://removed.example/m/" },
		});
		expect(l.link("gone", LAUNCHED)).toBeUndefined();
		expect(l.target("gone", LAUNCHED)).toBeUndefined();
		expect(l.openPath("gone", LAUNCHED)).toBeUndefined();
	});
	test("web.threadLinks overrides a server's link; an http(s) one is also where /open goes", () => {
		const l = createLinker({ servers: () => SERVERS, threadLinks: { mac: "https://t3.example/env-mac/" } });
		expect(l.link("mac", LAUNCHED)).toBe(`https://t3.example/env-mac/${LAUNCHED_PATH}`);
		expect(l.target("mac", LAUNCHED)).toBe(`https://t3.example/env-mac/${LAUNCHED_PATH}`);
		expect(l.link("omar", T1)).toBe(`t3-thread://v2/env-omar/${T1}`);
	});
	test("a t3-thread:// override is kept as the link, but /open still goes to the app: no browser opens t3-thread://", () => {
		const l = createLinker({
			servers: () => SERVERS,
			threadLinks: { mac: "t3-thread://v2/env-x/" },
			mirrorLinks: { mac: "t3-thread://v2/env-x/" },
		});
		expect(l.link("mac", T1)).toBe(`t3-thread://v2/env-x/${T1}`);
		expect(l.target("mac", T1)).toBe(`t3code://threads/env-mac/${T1}`);
	});
	test("an http(s) web.mirrorLinks prefix is where /open goes for that server", () => {
		const l = createLinker({ servers: () => SERVERS, mirrorLinks: { omar: "https://omar.example/t/" } });
		expect(l.target("omar", T1)).toBe(`https://omar.example/t/${T1}`);
	});
	test("an adapter without threadLinks is linked only by a prefix, for an id made of link-safe characters", () => {
		const thin = { server: { name: "thin", adapter: "fake" }, adapter: createFakeAdapter({ capabilities: [] }) };
		const l = createLinker({ servers: () => [thin], threadLinks: { thin: "https://thin.example/t/" } });
		expect(l.target("thin", "abc-1")).toBe("https://thin.example/t/abc-1");
		expect(l.target("thin", "a/b")).toBeUndefined();
	});
});

describe("the app link a view inside T3's phone app opens directly", () => {
	test("is the adapter's app link when that is where /open goes", () => {
		const l = createLinker({ servers: () => SERVERS });
		expect(l.appLink("mac", LAUNCHED)).toBe(`t3code://threads/env-mac/${LAUNCHED}`);
		expect(l.appLink("mithrandir", T1)).toBe(`t3code://threads/env-home/${T1}`);
	});
	test("is absent when the config sends the thread to an http(s) address, an environment is unknown, or the id is not T3's", () => {
		const l = createLinker({
			servers: () => [...SERVERS, t3("fresh", {})],
			threadLinks: { mac: "https://t3.example/m/" },
		});
		expect(l.appLink("mac", T1)).toBeUndefined();
		expect(l.appLink("fresh", T1)).toBeUndefined();
		expect(l.appLink("omar", "a/b")).toBeUndefined();
		expect(l.appLink("nowhere", T1)).toBeUndefined();
	});
	test("an appScheme a browser would run is never a target or an app link", () => {
		for (const scheme of ["javascript", "data", "vbscript", "file", "http", "https", "blob", "about"]) {
			const l = createLinker({ servers: () => [t3("odd", { environmentId: "env-odd", appScheme: scheme })] });
			expect([scheme, l.appLink("odd", T1), l.target("odd", T1), l.openPath("odd", T1)]).toEqual([
				scheme,
				undefined,
				undefined,
				undefined,
			]);
		}
		const dev = createLinker({ servers: () => [t3("dev", { environmentId: "env-dev", appScheme: "t3code-dev" })] });
		expect(dev.appLink("dev", T1)).toBe(`t3code-dev://threads/env-dev/${T1}`);
	});
	test("isAppLink takes only <scheme>://<link-safe characters> of a scheme no browser runs", () => {
		for (const ok of [
			`t3code://threads/env/${T1}`,
			`t3code://threads/env/${LAUNCHED}`,
			"t3code-preview://threads/e/thread:delegated-task:a%3Ab",
		])
			expect([ok, isAppLink(ok)]).toEqual([ok, true]);
		for (const bad of [
			"javascript://threads/%0aalert(1)",
			"JavaScript://x/y",
			"data://text/html,x",
			"vbscript://x",
			"file:///etc/passwd",
			"https://evil.example/x",
			"http://x/y",
			"t3code:threads/e/t",
			" t3code://threads/e/t",
			't3code://threads/e/t"><img src=x>',
			"t3code://threads/e/t <b>",
			"t3code://threads/e\\t",
			"T3CODE://threads/e/t",
			`t3code://${"a".repeat(1100)}`,
			"",
			undefined,
			42,
		])
			expect([bad, isAppLink(bad)]).toEqual([bad, false]);
	});
});

test("openPage escapes the target and the label", () => {
	const html = openPage('t3code://threads/e/t1"><script>', "<b>x</b>");
	expect(html).toContain('content="0;url=t3code://threads/e/t1&quot;&gt;&lt;script&gt;"');
	expect(html).not.toContain("<script>");
	expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
});

test("openPage goes on by itself and says what to do when nothing opened: a button and a clear line, never a bare link", () => {
	const html = openPage(`t3code://threads/e/${T1}`, "“Build it”");
	expect(html).toContain(`<meta http-equiv="refresh" content="0;url=t3code://threads/e/${T1}">`);
	expect(html).toContain(`<a class="open-go" href="t3code://threads/e/${T1}">Open “Build it”</a>`);
	expect(html).toContain("Nothing opened? Tap the button");
	expect(html).toContain("the app is not installed on this device");
	// The page's CSP allows no inline script or style; its look comes from the page's own stylesheet.
	expect(html).not.toMatch(/<script|style=|<style/);
	expect(html).toContain('<link rel="stylesheet" href="/app.css">');
	expect(openPage("https://t3.example/t/x", "the thread")).not.toContain("not installed");
});

// ---- the page: what the queue carries and what /open does ----

const HOST = "127.0.0.1:3790";
const ORIGIN = `http://${HOST}`;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const card: WaitingCard = {
	id: "C-aaaaaaaaaaaa",
	type: "approval",
	server: "mac",
	threadId: LAUNCHED,
	threadTitle: "Build it",
	requestId: "r1",
	question: "command",
	options: [],
	answerable: false,
	link: `t3-thread://v2/env-mac/${LAUNCHED}`,
	sig: "s",
};
function page(
	servers = SERVERS,
	secretRequest?: (q: {
		server: string;
		threadId?: string;
		cardRequest?: string;
		createdAt: string;
	}) => "open" | "ended" | undefined,
	more: Question[] = [],
) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-open-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const store = memStore();
	const q: Question = {
		id: "Q-abcd",
		kind: "product",
		title: "Pick one",
		context: "c",
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		thread: "Mobile app",
		server: "mithrandir",
		threadId: T1,
		createdAt: "2026-11-09T10:00:00.000Z",
	};
	askQuestion(store, q);
	askQuestion(store, { ...q, id: "Q-efgh", server: "laptop-gone", threadId: T2 });
	for (const m of more) askQuestion(store, m);
	const token = newToken();
	const app = createApp({
		capability: memoryCapability(token, { now: 1_800_000_000_000 }).capability,
		store,
		state: `${root}/state`,
		log: () => {},
		hosts: [HOST],
		staticDir: root,
		links: createLinker({ servers: () => servers }),
		mirror: {
			list: () => [card],
			answer: async () => ({ status: 200, body: {} }),
			...(secretRequest ? { secretRequest } : {}),
		},
	});
	const get = (path: string, headers: Record<string, string> = {}) =>
		app.fetch(new Request(`${ORIGIN}${path}`, { headers: { host: HOST, ...headers } }));
	return { token, get };
}

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

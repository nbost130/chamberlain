/**
 * A card's thread link and the page's `/open/<server>/<threadId>` route (./thread-links.ts): which link each server gets, which
 * config overrides it, and that the route sends a device only to a link it made itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { newToken } from "../core/capability.ts";
import type { Adapter, WaitingCard } from "../core/adapter.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { t3Linker } from "../adapters/t3/links.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { memoryCapability } from "../testing/capability.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import { createLinker, openPage } from "./thread-links.ts";
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

describe("createLinker", () => {
	const linker = createLinker({ servers: () => SERVERS });
	test("each server's link names its own environment", () => {
		expect(linker.link("mithrandir", "t1")).toBe("t3-thread://v2/env-home/t1");
		expect(linker.link("mac", "mcp:launch:ab12")).toBe("t3-thread://v2/env-mac/mcp:launch:ab12");
		expect(linker.link("omar", "t2")).toBe("t3-thread://v2/env-omar/t2");
	});
	test("/open sends a device to the app link, which a phone opens in T3 Code", () => {
		expect(linker.target("mac", "t1")).toBe("t3code://threads/env-mac/t1");
		expect(linker.openPath("mac", "mcp:launch:ab12")).toBe("/open/mac/mcp%3Alaunch%3Aab12");
	});
	test("a home server whose environment is not known yet has no link and no /open path, never a broken one", () => {
		const l = createLinker({ servers: () => [t3("mithrandir", {})] });
		expect(l.link("mithrandir", "t1")).toBeUndefined();
		expect(l.target("mithrandir", "t1")).toBeUndefined();
		expect(l.openPath("mithrandir", "t1")).toBeUndefined();
	});
	test("an unknown server, an adapter without threadLinks, or an id that is not one gives nothing", () => {
		const thin = { server: { name: "thin", adapter: "fake" }, adapter: createFakeAdapter({ capabilities: [] }) };
		const l = createLinker({ servers: () => [...SERVERS, thin] });
		expect(l.link("nowhere", "t1")).toBeUndefined();
		expect(l.openPath("thin", "t1")).toBeUndefined();
		for (const bad of ["a/b", "has space", "", "x\u0000"]) expect(l.openPath("mac", bad)).toBeUndefined();
		expect(l.link("__proto__", "t1")).toBeUndefined();
	});
	test("web.threadLinks overrides a server's link; an http(s) one is also where /open goes", () => {
		const l = createLinker({ servers: () => SERVERS, threadLinks: { mac: "https://t3.example/env-mac/" } });
		expect(l.link("mac", "a:b")).toBe("https://t3.example/env-mac/a%3Ab");
		expect(l.target("mac", "a:b")).toBe("https://t3.example/env-mac/a%3Ab");
		expect(l.link("omar", "t1")).toBe("t3-thread://v2/env-omar/t1");
	});
	test("a t3-thread:// override is kept as the link, but /open still goes to the app: no browser opens t3-thread://", () => {
		const l = createLinker({
			servers: () => SERVERS,
			threadLinks: { mac: "t3-thread://v2/env-x/" },
			mirrorLinks: { mac: "t3-thread://v2/env-x/" },
		});
		expect(l.link("mac", "t1")).toBe("t3-thread://v2/env-x/t1");
		expect(l.target("mac", "t1")).toBe("t3code://threads/env-mac/t1");
	});
	test("an http(s) web.mirrorLinks prefix is where /open goes for that server", () => {
		const l = createLinker({ servers: () => SERVERS, mirrorLinks: { omar: "https://omar.example/t/" } });
		expect(l.target("omar", "t1")).toBe("https://omar.example/t/t1");
	});
});

test("openPage escapes the target and the label", () => {
	const html = openPage('t3code://threads/e/t1"><script>', "<b>x</b>");
	expect(html).toContain('content="0;url=t3code://threads/e/t1&quot;&gt;&lt;script&gt;"');
	expect(html).not.toContain("<script>");
	expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
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
	threadId: "mcp:launch:ab12",
	threadTitle: "Build it",
	requestId: "r1",
	question: "command",
	options: [],
	answerable: false,
	link: "t3-thread://v2/env-mac/mcp:launch:ab12",
	sig: "s",
};
function page(servers = SERVERS) {
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
		threadId: "11111111-2222-3333-4444-555555555555",
		createdAt: "2026-11-09T10:00:00.000Z",
	};
	askQuestion(store, q);
	askQuestion(store, { ...q, id: "Q-efgh", server: "laptop-gone", threadId: "t9" });
	const token = newToken();
	const app = createApp({
		capability: memoryCapability(token, { now: 1_800_000_000_000 }).capability,
		store,
		state: `${root}/state`,
		log: () => {},
		hosts: [HOST],
		staticDir: root,
		links: createLinker({ servers: () => servers }),
		mirror: { list: () => [card], answer: async () => ({ status: 200, body: {} }) },
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
		expect(plain.link).toBe("t3-thread://v2/env-home/11111111-2222-3333-4444-555555555555");
		expect(plain.open).toBe("/open/mithrandir/11111111-2222-3333-4444-555555555555");
		const gone = q.items.find((i: any) => i.id === "Q-efgh");
		expect(gone.link).toBeUndefined();
		expect(gone.open).toBeUndefined();
		expect(q.cards[0].open).toBe("/open/mac/mcp%3Alaunch%3Aab12");
		expect(q.cards[0].link).toBe("t3-thread://v2/env-mac/mcp:launch:ab12");
	});
	test("/open with ?k= signs the browser in and drops the key; then it sends the device on to the app link", async () => {
		const { token, get } = page();
		const r = await get(`/open/mac/mcp%3Alaunch%3Aab12?k=${token}`);
		expect(r.status).toBe(303);
		expect(r.headers.get("location")).toBe("/open/mac/mcp%3Alaunch%3Aab12");
		const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
		const o = await get("/open/mac/mcp%3Alaunch%3Aab12", { cookie });
		expect(o.status).toBe(200);
		const html = await o.text();
		expect(html).toContain('http-equiv="refresh" content="0;url=t3code://threads/env-mac/mcp:launch:ab12"');
		expect(html).toContain('href="t3code://threads/env-mac/mcp:launch:ab12"');
		expect(html).toContain("Build it");
		expect(o.headers.get("content-security-policy")).toContain("script-src 'self'");
	});
	test("/open needs the key, and gives no page for a thread it cannot link", async () => {
		const { token, get } = page();
		expect((await get("/open/mac/t1")).status).toBe(401);
		expect((await get("/open/laptop-gone/t9", { "x-decision-token": token })).status).toBe(404);
		expect((await get("/open/mac/a%2Fb", { "x-decision-token": token })).status).toBe(404);
		expect((await get("/open/mac/%E0%A4%A", { "x-decision-token": token })).status).toBe(400);
	});
	test("/open goes only where the linker says: a target in the query is ignored", async () => {
		const { token, get } = page();
		const html = await (await get("/open/mac/t1?to=https://evil.example", { "x-decision-token": token })).text();
		expect(html).toContain("t3code://threads/env-mac/t1");
		expect(html).not.toContain("evil.example");
	});
});

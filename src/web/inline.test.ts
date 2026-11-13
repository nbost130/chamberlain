/** T3's inline frames (origin "null") may read the queue and answer a question; any other foreign origin is still refused. What an inline frame may NOT do is in inline-authority.test.ts. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { fetchWake } from "../testing/wake.ts";
import { askQuestion, recordAnswerDelivered, type Question } from "../core/questions.ts";
import { createApp } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-inline-`);
	dirs.push(root);
	const state = `${root}/state`;
	const store = memStore();
	const item: Question = { id: "Q-abcd", kind: "product", title: "Pick one", context: "x", options: [{ label: "A" }, { label: "B" }], recommended: 0, thread: "t", server: "main", createdAt: "2026-11-09T10:00:00.000Z" };
	askQuestion(store, item);
	const posted: string[] = [];
	const { drain } = testRelay(store, fetchWake(() => "http://webhook.test/wake", (async (_u: string, init: RequestInit) => { posted.push(String(init.body)); return new Response(null, { status: 202 }); }) as unknown as typeof fetch));
	const page = createApp({ store, state, log: () => {}, hosts: [HOST], staticDir: root });
	const app = { ...page, idle: async () => { await page.idle(); await drain(); } };
	const req = (path: string, init: RequestInit & { origin?: string } = {}) => {
		const headers: Record<string, string> = { host: HOST, ...(init.headers as Record<string, string> | undefined) };
		if (init.origin) headers.origin = init.origin;
		return app.fetch(new Request(`http://${HOST}${path}`, { ...init, headers }));
	};
	const answer = (origin: string) => req("/api/items/Q-abcd/answer", { method: "POST", origin, headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0 }) });
	return { req, answer, app, posted };
}

test("a preflight from an inline frame is allowed for the API", async () => {
	const { req } = setup();
	const r = await req("/api/items/Q-abcd/answer", { method: "OPTIONS", origin: "null" });
	expect(r.status).toBe(204);
	expect(r.headers.get("access-control-allow-origin")).toBe("null");
	expect(r.headers.get("access-control-allow-headers")).toContain("x-decision-queue");
});

test("an inline frame can read the queue and answer once", async () => {
	const { req, answer, app, posted } = setup();
	const q = await req("/api/queue", { origin: "null" });
	expect(q.status).toBe(200);
	expect(q.headers.get("access-control-allow-origin")).toBe("null");
	expect((await answer("null")).status).toBe(200);
	await app.idle();
	expect((await answer("null")).status).toBe(409);
	expect(posted).toHaveLength(1);
});

test("any other foreign origin is still refused, and gets no CORS", async () => {
	const { req, answer } = setup();
	const r = await answer("https://example.com");
	expect(r.status).toBe(403);
	expect(r.headers.get("access-control-allow-origin")).toBeNull();
	expect((await req("/api/queue", { origin: "https://example.com" })).headers.get("access-control-allow-origin")).toBeNull();
});

test("an inline frame can't touch rulings or batch accept, and gets no CORS there", async () => {
	const { req } = setup();
	const post = (path: string) => req(path, { method: "POST", origin: "null", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ ids: ["Q-abcd"], decides: "x" }) });
	for (const p of ["/api/rulings/R1/edit", "/api/rulings/R1/retire", "/api/accept-all"]) {
		const r = await post(p);
		expect(r.status).toBe(403);
		expect(r.headers.get("access-control-allow-origin")).toBeNull();
	}
	expect((await req("/api/rulings/R1/edit", { method: "OPTIONS", origin: "null" })).headers.get("access-control-allow-origin")).toBeNull();
	expect((await req("/api/rulings", { method: "POST", origin: "null", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: "{}" })).status).toBe(403);
});

test("the Decisions view may read the rulings and recent answers", async () => {
	const { req, answer, app } = setup();
	const r = await req("/api/rulings", { origin: "null" });
	expect(r.status).toBe(200);
	expect(r.headers.get("access-control-allow-origin")).toBe("null");
	expect(Array.isArray((await r.json()).rulings)).toBe(true);
	expect((await (await req("/api/recent", { origin: "null" })).json()).items).toHaveLength(0);
	expect(app.openCount()).toBe(1);
	await answer("null");
	await app.idle();
	const recent = await req("/api/recent", { origin: "null" });
	expect(recent.headers.get("access-control-allow-origin")).toBe("null");
	const items = (await recent.json()).items;
	expect(items.map((i: { id: string }) => i.id)).toEqual(["Q-abcd"]);
	expect(items[0].answer.label).toBe("A");
	expect(app.openCount()).toBe(0);
});

test("only the exact origin null is let in: other spellings are refused", async () => {
	const { answer } = setup();
	for (const o of ["NULL", "Null", ".*", "null.example.com", "http://null"]) {
		const r = await answer(o);
		expect(r.status).toBe(403);
		expect(r.headers.get("access-control-allow-origin")).toBeNull();
	}
});

test("inline requests still meet the Host, content-type and item checks", async () => {
	const { app, req } = setup();
	const bad = await app.fetch(new Request("http://evil.example/api/queue", { headers: { host: "evil.example", origin: "null" } }));
	expect(bad.status).toBe(421);
	const wrongType = await req("/api/items/Q-abcd/answer", { method: "POST", origin: "null", headers: { "content-type": "text/plain", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0 }) });
	expect(wrongType.status).toBe(403);
	const noItem = await req("/api/items/Q-zzzz/answer", { method: "POST", origin: "null", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0 }) });
	expect(noItem.status).toBe(404);
});

test("a preflight changes nothing", async () => {
	const { req, posted } = setup();
	await req("/api/items/Q-abcd/answer", { method: "OPTIONS", origin: "null" });
	expect(posted).toHaveLength(0);
	expect((await (await req("/api/queue", { origin: "null" })).json()).items).toHaveLength(1);
});

test("an inline answer still needs the queue header", async () => {
	const { req } = setup();
	const r = await req("/api/items/Q-abcd/answer", { method: "POST", origin: "null", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: 0 }) });
	expect(r.status).toBe(403);
});

test("mirrored cards come with the queue and count toward the title, but an inline frame may not answer them", async () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-inline-m-`);
	dirs.push(root);
	const state = `${root}/state`;
	const card = { id: "C-0123456789ab", type: "question" as const, server: "main", threadId: "t", threadTitle: "T", requestId: "r", question: "Q?", options: [{ label: "A" }], answerable: true, sig: "s" };
	const answered: unknown[] = [];
	const mirror = { list: () => [card], answer: async (id: string, choice: unknown, sig: unknown) => { answered.push([id, choice, sig]); return { status: 200, body: { ok: true, choice: "A" } }; } };
	const app = createApp({ store: memStore(), state, log: () => {}, hosts: [HOST], staticDir: root, mirror });
	const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, origin: "null", ...(init.headers as Record<string, string> | undefined) } }));
	const q = await (await req("/api/queue")).json();
	expect(q.cards).toEqual([card]);
	expect(app.openCount()).toBe(1);
	const r = await req(`/api/cards/${card.id}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0, sig: "s" }) });
	expect(r.status).toBe(403);
	expect(r.headers.get("access-control-allow-origin")).toBeNull();
	expect(answered).toEqual([]);
	const noHeader = await req(`/api/cards/${card.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	expect(noHeader.status).toBe(403);
	expect((await req("/api/cards/C-zz/answer", { method: "POST", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: "{}" })).headers.get("access-control-allow-origin")).toBeNull();
});

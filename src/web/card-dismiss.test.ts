/**
 * Mirrored waiting-card dismiss (#68 / B2): every kind gets a Dismiss on the page and inline view; the API hides that request
 * id from the views without touching the thread; a new request id shows again; double dismiss is 409; a restricted key is refused.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { isCardDismissed } from "../core/items/card-dismiss.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { memoryCapability } from "../testing/capability.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { run, settle } from "../testing/inline-dom.ts";
import { memStore } from "../testing/store.ts";
import { approval, cardPage } from "../testing/web-app-view-fixtures.ts";
import { buttons, card as inlineCard } from "../testing/web-inline-view-fixtures.ts";
import { createApp } from "./app.ts";
import { createWaiting } from "./waiting.ts";

const HOST = "127.0.0.1:3793";
const ORIGIN = `http://${HOST}`;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KINDS: WaitingCard["type"][] = ["approval", "goal", "secret", "link", "question"];

/** Card ids the view-key path accepts (`C-` + 12 hex). */
const HEX_ID: Record<WaitingCard["type"], string> = {
	approval: "C-a00000000001",
	goal: "C-b00000000001",
	secret: "C-c00000000001",
	link: "C-d00000000001",
	question: "C-e00000000001",
};

function waitingCard(type: WaitingCard["type"], over: Partial<WaitingCard> = {}): WaitingCard {
	const answerable = type === "question" || type === "approval" || type === "goal";
	return {
		id: HEX_ID[type],
		type,
		server: "fake",
		threadId: "t1",
		threadTitle: "Build",
		requestId: `req-${type}`,
		header: type,
		question: `${type} body`,
		options: answerable ? [{ label: "Yes" }, { label: "No" }] : [],
		answerable,
		why: answerable ? undefined : `answer ${type} in its thread`,
		sig: `sig-${type}`,
		...(type === "approval" || type === "goal" ? { command: "echo hi" } : {}),
		...over,
	};
}

async function appWith(cards: WaitingCard[]) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-card-dismiss-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const fake = createFakeAdapter();
	fake.cards = cards;
	const store = memStore();
	const logs: Record<string, unknown>[] = [];
	const log = (event: string, data?: Record<string, unknown>) => logs.push({ event, ...data });
	const mirror = createWaiting({
		store,
		servers: () => [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		skipThreads: () => [],
		log,
	});
	await mirror.poll();
	const page = newToken();
	const view = newToken();
	const cap = memoryCapability(page, { now: NOW }, view);
	const app = createApp({
		capability: cap.capability,
		store,
		state: `${root}/state`,
		log,
		hosts: [HOST],
		staticDir: root,
		mirror,
		now: () => NOW,
	});
	const h = (tok: string, extra: Record<string, string> = {}) => ({
		host: HOST,
		origin: ORIGIN,
		[TOKEN_HEADER]: tok,
		"content-type": "application/json",
		"x-decision-queue": "1",
		...extra,
	});
	const post = (path: string, tok: string, body: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
		app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: h(tok, extra), body: JSON.stringify(body) }));
	const queue = (tok: string) =>
		app.fetch(new Request(`${ORIGIN}/api/queue`, { headers: { host: HOST, origin: ORIGIN, [TOKEN_HEADER]: tok } }));
	return { app, fake, store, mirror, page, view, post, queue, logs, cap };
}

describe("mirrored card dismiss API", () => {
	for (const type of KINDS) {
		test(`${type}: dismiss hides the card, leaves the adapter untouched, and records the page key`, async () => {
			const c = waitingCard(type);
			const s = await appWith([c]);
			expect((await s.queue(s.page)).status).toBe(200);
			const before = await (await s.queue(s.page)).json();
			expect(before.cards.map((x: { id: string }) => x.id)).toEqual([c.id]);
			const r = await s.post(`/api/cards/${c.id}/dismiss`, s.page);
			expect(r.status).toBe(200);
			expect(await r.json()).toEqual({ ok: true, id: c.id, kind: "dismissed", recorded: true });
			expect(s.fake.answers).toEqual([]);
			expect(s.fake.cards.map((x) => x.requestId)).toEqual([c.requestId]);
			expect(isCardDismissed(s.store, c.server, c.threadId, c.requestId)).toBe(true);
			const after = await (await s.queue(s.page)).json();
			expect(after.cards).toEqual([]);
			expect(s.logs.filter((l) => l.event === "card-dismissed")).toMatchObject([
				{ id: c.id, type, key: "page", requestId: c.requestId },
			]);
		});
	}

	test("a new request id shows again after a dismiss of the prior one", async () => {
		const first = waitingCard("approval", { id: "C-aaaaaaaaaaaa", requestId: "req-1" });
		const s = await appWith([first]);
		expect((await s.post(`/api/cards/${first.id}/dismiss`, s.page)).status).toBe(200);
		expect((await (await s.queue(s.page)).json()).cards).toEqual([]);
		const second = waitingCard("approval", { id: "C-bbbbbbbbbbbb", requestId: "req-2", sig: "sig-2" });
		s.fake.cards = [second];
		await s.mirror.poll();
		const listed = (await (await s.queue(s.page)).json()).cards;
		expect(listed.map((x: { id: string; requestId: string }) => [x.id, x.requestId])).toEqual([[second.id, "req-2"]]);
	});

	test("double dismiss returns 409 and does not answer the thread", async () => {
		const c = waitingCard("approval");
		const s = await appWith([c]);
		expect((await s.post(`/api/cards/${c.id}/dismiss`, s.page)).status).toBe(200);
		const again = await s.post(`/api/cards/${c.id}/dismiss`, s.page);
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ error: "already dismissed", code: "already-dismissed" });
		expect(s.fake.answers).toEqual([]);
	});

	test("the view key may dismiss; a restricted page key may not", async () => {
		const c = waitingCard("secret");
		const s = await appWith([c]);
		const viewOk = await s.post(`/api/cards/${c.id}/dismiss`, s.view, {}, { origin: "null" });
		expect(viewOk.status).toBe(200);
		expect(s.logs.some((l) => l.event === "card-dismissed" && l.key === "view")).toBe(true);

		const other = waitingCard("link", { id: "C-d00000000002", requestId: "req-link-2" });
		s.fake.cards = [other];
		await s.mirror.poll();
		const restricted = await s.post(`/api/cards/${other.id}/dismiss`, s.page, {}, { origin: "null" });
		expect(restricted.status).toBe(403);
		expect(isCardDismissed(s.store, other.server, other.threadId, other.requestId)).toBe(false);
		expect(s.fake.answers).toEqual([]);
	});

	test("same server and requestId in another thread stays visible (Sol R1-M2)", async () => {
		const a = waitingCard("approval", { id: "C-a0000000000a", threadId: "t1", requestId: "req-shared" });
		const b = waitingCard("approval", {
			id: "C-a0000000000b",
			threadId: "t2",
			requestId: "req-shared",
			threadTitle: "Other",
			sig: "sig-b",
		});
		const s = await appWith([a, b]);
		expect((await (await s.queue(s.page)).json()).cards.map((c: { id: string }) => c.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
		expect((await s.post(`/api/cards/${a.id}/dismiss`, s.page)).status).toBe(200);
		await s.mirror.poll();
		const listed = (await (await s.queue(s.page)).json()).cards;
		expect(listed.map((c: { id: string; threadId: string }) => [c.id, c.threadId])).toEqual([[b.id, "t2"]]);
		expect(isCardDismissed(s.store, a.server, a.threadId, a.requestId)).toBe(true);
		expect(isCardDismissed(s.store, b.server, b.threadId, b.requestId)).toBe(false);
	});
});

describe("mirrored card dismiss UI", () => {
	for (const type of KINDS) {
		test(`full page: ${type} renders Dismiss`, async () => {
			const c = { ...approval, ...waitingCard(type), id: approval.id };
			const p = await cardPage([c], () => ({ json: { ok: true, kind: "dismissed" } }));
			expect(p.app.innerHTML).toContain('data-cact="dismiss"');
			expect(p.app.innerHTML).toContain(`data-cid="${c.id}"`);
			expect(p.app.innerHTML).toMatch(/>Dismiss</);
		});

		test(`inline: ${type} renders Dismiss`, async () => {
			const base = type === "approval" ? inlineCard("rm -rf build", "sig-1") : inlineCard("cmd", `sig-${type}`);
			const mirrored = { ...base, ...waitingCard(type) };
			const dq = run(() => ({ items: [], cards: [mirrored] }));
			await settle();
			expect(buttons(dq)).toContain("Dismiss");
		});
	}

	test("full page dismiss posts /api/cards/<id>/dismiss and removes the card", async () => {
		const p = await cardPage([approval], () => ({ json: { ok: true, kind: "dismissed" } }));
		const confirm = globalThis.confirm;
		globalThis.confirm = () => true;
		try {
			await p.click("dismiss", approval.id);
		} finally {
			globalThis.confirm = confirm;
		}
		expect(p.calls).toEqual([{ path: `/api/cards/${approval.id}/dismiss`, body: {} }]);
		expect(p.app.innerHTML).not.toContain(approval.id);
	});

	// Sol R1-M1: dismiss must remove the node (not leave it via data-answered preserve), and Refresh must keep it gone.
	test("inline dismiss removes the card node after POST and after Refresh", async () => {
		const mirrored = { ...inlineCard("rm -rf build", "sig-1"), ...waitingCard("approval") };
		let cards: (typeof mirrored)[] = [mirrored];
		const calls: { method: string; path: string; body?: unknown }[] = [];
		const dq = run(() => ({ items: [], cards }), {
			calls,
			post: () => {
				cards = [];
				return { status: 200, body: { ok: true, kind: "dismissed" } };
			},
		});
		await settle();
		const cardNodes = () => dq.all((e) => e.className.split(" ").includes("dq-card"));
		expect(cardNodes()).toHaveLength(1);
		expect(cardNodes()[0]!.dataset.answered).toBeUndefined();
		const dismiss = dq.all((e) => e.tag === "button" && e.textContent === "Dismiss")[0]!;
		for (const fn of dismiss.listeners.click ?? []) await fn();
		await settle();
		expect(calls.filter((c) => c.method === "POST")).toEqual([
			{ method: "POST", path: `/api/cards/${mirrored.id}/dismiss`, body: {} },
		]);
		expect(cardNodes()).toHaveLength(0);
		expect(dq.textContent).not.toContain(mirrored.header);
		const refresh = dq.all((e) => e.tag === "button" && e.textContent === "Refresh")[0]!;
		for (const fn of refresh.listeners.click ?? []) await fn();
		await settle();
		expect(cardNodes()).toHaveLength(0);
		expect(dq.textContent).not.toContain(mirrored.header);
	});
});

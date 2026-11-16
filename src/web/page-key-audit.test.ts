/**
 * Every write the full page makes is recorded with the key it was made with (`key: "page"`), so the trail tells it from a write made in place
 * with the view key (view-key.test.ts). One test per write path: an option answer, a batch accept, snooze, un-snooze, direction, dismiss, not-now,
 * each ruling action, a card's confirmation (issued and refused) and a card's answer. Real handler, real capability, a signed cookie.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { newToken } from "../core/ops/capability.ts";
import { propose, readRulings } from "../core/ops/rulings.ts";
import { memoryCapability } from "../testing/capability.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import { createWaiting } from "./waiting.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3792";
const ORIGIN = `http://${HOST}`;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string): Question => ({
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
});
const approval: WaitingCard = {
	id: "C-0123456789ab",
	type: "approval",
	server: "fake",
	threadId: "t1",
	threadTitle: "Build",
	requestId: "r1",
	question: "Run this?",
	options: [{ label: "Approve once" }, { label: "Decline" }],
	answerable: true,
	sig: "sig-1",
	command: "rm -rf build",
};

async function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-pageaudit-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const fake = createFakeAdapter();
	fake.cards = [approval];
	const mirror = createWaiting({
		store: memStore(),
		servers: () => [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		skipThreads: () => [],
		log: () => {},
	});
	await mirror.poll();
	const store = memStore();
	for (const id of ["Q-aaaa", "Q-bbbb", "Q-cccc", "Q-dddd", "Q-eeee", "Q-ffff"]) askQuestion(store, question(id));
	const logs: Record<string, unknown>[] = [];
	const page = newToken();
	const cap = memoryCapability(page, { now: NOW });
	const app = createApp({
		capability: cap.capability,
		store,
		state: `${root}/state`,
		log: (event, data) => logs.push({ event, ...data }),
		hosts: [HOST],
		staticDir: root,
		mirror,
		now: () => NOW,
	});
	const link = await app.fetch(new Request(`${ORIGIN}/?k=${encodeURIComponent(page)}`, { headers: { host: HOST } }));
	const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const post = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
		app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: {
					host: HOST,
					cookie,
					origin: ORIGIN,
					"content-type": "application/json",
					"x-decision-queue": "1",
					...extra,
				},
				body: JSON.stringify(body),
			}),
		);
	const events = (name: string) => logs.filter((l) => l.event === name);
	return { app, store, post, events, cookie };
}

describe("each full-page write is recorded with key: page", () => {
	test("an option answer", async () => {
		const s = await setup();
		expect((await s.post("/api/items/Q-aaaa/answer", { choice: 1, note: "n" })).status).toBe(200);
		expect(s.events("answered")).toMatchObject([{ id: "Q-aaaa", key: "page" }]);
	});
	test("a batch accept", async () => {
		const s = await setup();
		expect((await s.post("/api/accept-all", { ids: ["Q-bbbb"] })).status).toBe(200);
		expect(s.events("answered")).toMatchObject([{ id: "Q-bbbb", by: "batch", key: "page" }]);
	});
	test("snooze, un-snooze, direction and dismiss", async () => {
		const s = await setup();
		const until = new Date(NOW + 3_600_000).toISOString();
		expect((await s.post("/api/items/Q-cccc/snooze", { until })).status).toBe(200);
		expect((await s.post("/api/items/Q-cccc/unsnooze")).status).toBe(200);
		expect((await s.post("/api/items/Q-cccc/direction", { note: "go" })).status).toBe(200);
		expect((await s.post("/api/items/Q-dddd/dismiss")).status).toBe(200);
		expect(s.events("snoozed")).toMatchObject([{ id: "Q-cccc", key: "page" }]);
		expect(s.events("unsnoozed")).toMatchObject([{ id: "Q-cccc", key: "page" }]);
		expect(s.events("directed")).toMatchObject([{ id: "Q-cccc", key: "page" }]);
		expect(s.events("dismissed")).toMatchObject([{ id: "Q-dddd", key: "page" }]);
	});
	test("not-now", async () => {
		const s = await setup();
		expect((await s.post("/api/items/Q-eeee/not-now")).status).toBe(200);
		expect(s.events("not-now")).toEqual([{ event: "not-now", id: "Q-eeee", key: "page" }]);
	});
	for (const action of ["edit", "confirm", "once", "retire"] as const) {
		test(`the ruling action ${action}`, async () => {
			const s = await setup();
			const p = propose(s.store, { words: "Approve (Recommended)", decides: "gates" });
			if (action === "once" || action === "retire") await s.post(`/api/rulings/${p.id}/confirm`, {});
			const r = await s.post(`/api/rulings/${p.id}/${action}`, action === "edit" ? { decides: "gates, edited" } : {});
			expect([action, r.status]).toEqual([action, 200]);
			expect(readRulings(s.store)).toHaveLength(1);
			expect(s.events("ruling-changed").filter((l) => l.action === action)).toMatchObject([
				{ id: p.id, action, key: "page" },
			]);
		});
	}
	test("a card's confirmation, issued and refused, and its answer", async () => {
		const s = await setup();
		const asked = await s.post("/api/cards/C-0123456789ab/confirm", { choice: 0, sig: "sig-1" });
		expect(asked.status).toBe(200);
		const session = (asked.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const { challenge } = (await asked.json()) as { challenge: string };
		expect(s.events("card-confirmation-issued")).toMatchObject([{ id: "C-0123456789ab", key: "page" }]);
		const refused = await s.post("/api/cards/C-0123456789ab/answer", { choice: 0, sig: "sig-1" });
		expect(refused.status).toBe(428);
		expect(s.events("card-confirmation-refused")).toMatchObject([{ id: "C-0123456789ab", key: "page" }]);
		const answered = await s.post(
			"/api/cards/C-0123456789ab/answer",
			{ choice: 0, sig: "sig-1", challenge },
			{ cookie: `${s.cookie}; ${session}` },
		);
		expect(answered.status).toBe(200);
		expect(s.events("card-answered")).toMatchObject([{ id: "C-0123456789ab", status: 200, key: "page" }]);
	});
});

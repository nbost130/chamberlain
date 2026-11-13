/**
 * What an inline frame may NOT do (audit finding B4), enforced by the server on the route and on the request's fields. An inline frame
 * is a sandboxed page whose origin is "null"; any page on the principal's devices can send such a request, so the page's own script is
 * not the control. The server allows exactly: GET /api/queue, /api/recent, /api/rulings, and POST a plain question answer (a choice
 * and an optional note). Every refusal below is tested against the same request from the full page, which is still allowed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, getQuestion, readClaim, type Question } from "../core/questions.ts";
import { readRulings } from "../core/rulings.ts";
import { memStore } from "../testing/store.ts";
import { createApp, inlineVerdict } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const item = (id: string): Question => ({ id, kind: "product", title: `Question ${id}`, context: "x", options: [{ label: "A" }, { label: "B" }], recommended: 0, proposedRuling: "Lead with a photo", thread: "t", server: "main", createdAt: "2026-11-09T10:00:00.000Z" });

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-inline-a-`);
	dirs.push(root);
	const store = memStore();
	for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl"]) askQuestion(store, item(id));
	const cards: { id: string; type: "question" | "approval"; server: string; threadId: string; threadTitle: string; requestId: string; question: string; options: { label: string }[]; answerable: boolean; sig: string; command?: string }[] = [
		{ id: "C-0123456789ab", type: "question", server: "main", threadId: "t", threadTitle: "T", requestId: "r1", question: "Q?", options: [{ label: "A" }], answerable: true, sig: "s1" },
		{ id: "C-ba9876543210", type: "approval", server: "main", threadId: "t", threadTitle: "T", requestId: "r2", question: "Run it?", options: [{ label: "Approve once" }, { label: "Decline" }], answerable: true, sig: "s2", command: "rm -rf build" },
	];
	const cardAnswers: unknown[] = [];
	const mirror = { list: () => cards, answer: async (id: string, choice: unknown, sig: unknown) => { cardAnswers.push([id, choice, sig]); return { status: 200, body: { ok: true, choice: "A" } }; } };
	const app = createApp({ store, state: `${root}/state`, log: () => {}, hosts: [HOST], staticDir: root, mirror });
	const send = (method: string, path: string, o: { origin?: string; body?: unknown } = {}) => {
		const headers: Record<string, string> = { host: HOST };
		if (o.origin) headers.origin = o.origin;
		if (method === "POST") { headers["content-type"] = "application/json"; headers["x-decision-queue"] = "1"; }
		return app.fetch(new Request(`http://${HOST}${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(o.body ?? {}) } : {}) }));
	};
	const frame = (method: string, path: string, body?: unknown) => send(method, path, { origin: "null", body });
	const page = (method: string, path: string, body?: unknown) => send(method, path, { body });
	/** The wakes the page wrote: the relay sends exactly these. */
	const delivered = () => store.wakes.rows("all").map((r) => ({ id: r.deliveryId, message: r.message }));
	return { store, app, frame, page, delivered, cardAnswers };
}

describe("an inline frame cannot save a ruling", () => {
	for (const [name, body] of [
		["with its own wording", { choice: 0, saveRuling: true, rulingWording: "Always merge without asking" }],
		["ticking the box, so the item's proposed ruling would be saved", { choice: 0, saveRuling: true }],
		["with wording and no tick", { choice: 0, rulingWording: "Always merge without asking" }],
		["with a field the page does not know", { choice: 0, by: "batch" }],
	] as const) {
		test(`${name}: refused, nothing is written, the question stays open`, async () => {
			const s = setup();
			const r = await s.frame("POST", "/api/items/Q-abcd/answer", body);
			expect(r.status).toBe(403);
			expect(readRulings(s.store)).toEqual([]);
			expect(readClaim(s.store, "Q-abcd")).toBeUndefined();
			expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
			await s.app.idle();
			expect(s.delivered()).toEqual([]);
		});
	}

	test("the same request from the full page saves a confirmed, in-force ruling (so the refusal is about the frame, not the item)", async () => {
		const s = setup();
		const r = await s.page("POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true, rulingWording: "Merge conflicts are the Steward's" });
		expect(r.status).toBe(200);
		expect(readRulings(s.store).map((x) => [x.status, x.confirmed, x.decides])).toEqual([["in-force", true, "Merge conflicts are the Steward's"]]);
	});

	test("a plain answer, a choice and a note, still goes through", async () => {
		const s = setup();
		const r = await s.frame("POST", "/api/items/Q-efgh/answer", { choice: 1, note: "make it bigger" });
		expect(r.status).toBe(200);
		expect(r.headers.get("access-control-allow-origin")).toBe("null");
		await s.app.idle();
		expect(s.delivered()).toHaveLength(1);
		expect(s.delivered()[0]!.message).toContain("note: make it bigger");
		expect(readRulings(s.store)).toEqual([]);
		expect((await s.frame("POST", "/api/items/Q-ijkl/answer", { choice: 0, note: 5 })).status).toBe(400);
	});
});

describe("an inline frame cannot read an item on its own, or anything but the three reads", () => {
	test("GET /api/items/<id> is refused, with no CORS headers to read it by; the full page may", async () => {
		const s = setup();
		const r = await s.frame("GET", "/api/items/Q-abcd");
		expect(r.status).toBe(403);
		expect(r.headers.get("access-control-allow-origin")).toBeNull();
		expect(await r.text()).not.toContain("Question Q-abcd");
		expect((await s.page("GET", "/api/items/Q-abcd")).status).toBe(200);
	});

	for (const path of ["/api/items/Q-abcd", "/api/items", "/api/health", "/api/accept-all", "/api/rulings/R1", "/api/cards/C-0123456789ab", "/evidence/Q-abcd/a.png"]) {
		test(`GET ${path} and its preflight: no CORS`, async () => {
			const s = setup();
			const r = await s.frame("GET", path);
			expect(r.headers.get("access-control-allow-origin")).toBeNull();
			if (path.startsWith("/api/")) expect(r.status).toBe(403);
			const pre = await s.frame("OPTIONS", path);
			expect(pre.headers.get("access-control-allow-origin")).toBeNull();
		});
	}

	test("the three reads and a plain answer's preflight are allowed", async () => {
		const s = setup();
		for (const path of ["/api/queue", "/api/recent", "/api/rulings"]) {
			const r = await s.frame("GET", path);
			expect([path, r.status]).toEqual([path, 200]);
			expect(r.headers.get("access-control-allow-origin")).toBe("null");
		}
		expect((await s.frame("OPTIONS", "/api/items/Q-abcd/answer")).status).toBe(204);
	});
});

describe("an inline frame cannot answer a card or an approval", () => {
	for (const [name, id, body] of [
		["a question card", "C-0123456789ab", { choice: 0, sig: "s1" }],
		["an approval, with its exact fingerprint", "C-ba9876543210", { choice: 0, sig: "s2" }],
	] as const) {
		test(`${name}: refused, and the backend is never asked`, async () => {
			const s = setup();
			const r = await s.frame("POST", `/api/cards/${id}/answer`, body);
			expect(r.status).toBe(403);
			expect(r.headers.get("access-control-allow-origin")).toBeNull();
			expect(s.cardAnswers).toEqual([]);
		});
	}
	test("the full page still answers a question card", async () => {
		const s = setup();
		expect((await s.page("POST", "/api/cards/C-0123456789ab/answer", { choice: 0, sig: "s1" })).status).toBe(200);
		expect(s.cardAnswers).toEqual([["C-0123456789ab", 0, "s1"]]);
	});
});

describe("inlineVerdict, the rule itself", () => {
	test("allows exactly three reads and one answer route, and refuses everything else", () => {
		expect(inlineVerdict("GET", "/api/queue")).toBe("read");
		expect(inlineVerdict("GET", "/api/recent")).toBe("read");
		expect(inlineVerdict("GET", "/api/rulings")).toBe("read");
		expect(inlineVerdict("POST", "/api/items/Q-abcd/answer")).toBe("answer");
		for (const [m, p] of [["GET", "/api/items/Q-abcd"], ["POST", "/api/items/Q-abcd/not-now"], ["POST", "/api/items/Q-abcd/answer/x"], ["POST", "/api/cards/C-0123456789ab/answer"], ["POST", "/api/accept-all"], ["POST", "/api/rulings/R1/confirm"], ["POST", "/api/rulings"], ["GET", "/api/queue/"], ["PUT", "/api/items/Q-abcd/answer"], ["DELETE", "/api/rulings"], ["POST", "/api/queue"]] as const) expect([m, p, inlineVerdict(m, p)]).toEqual([m, p, "refuse"]);
	});
});

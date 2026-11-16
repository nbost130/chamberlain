/**
 * The VIEW key and the cards waiting in other threads, against the real handler (createApp) with a real capability. The Decisions view answers a
 * builder's QUESTION card in place (Nathan, 2026-11-15: "Why can't all come through the inline method?"), through the same `mirror.answer` the full
 * page uses, with a choice and the card's fingerprint and nothing else. Every other kind the full page also keeps from a frame stays refused to the
 * view key: an approval and a goal proposal (they take the server's confirmation, and run or commit to something), a secret and a machine link
 * (never answerable anywhere on the page). The page key from a frame or with no Origin still answers no card at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { memoryCapability } from "../testing/capability.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import { VIEW_KEY_CARD_TYPES } from "./view-key.ts";
import { UNCONFIRMED_CARD_TYPES } from "./waiting.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3795";
const ORIGIN = `http://${HOST}`;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const card = (n: number, type: WaitingCard["type"], over: Partial<WaitingCard> = {}): WaitingCard => ({
	id: `C-00000000000${n}`,
	type,
	server: "builder",
	threadId: `bt-${n}`,
	threadTitle: `Builder ${n}`,
	requestId: `r-${n}`,
	header: "Which schema?",
	question: "Pick one",
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	answerable: true,
	sig: `sig-${n}`,
	...over,
});
const CARDS = {
	question: card(1, "question"),
	approval: card(2, "approval", {
		command: "rm -rf build",
		options: [{ label: "Approve once" }, { label: "Decline" }],
	}),
	goal: card(3, "goal", { command: "Ship the importer" }),
	secret: card(4, "secret", { answerable: false, why: "Enter it in its thread." }),
	link: card(5, "link", { answerable: false, why: "Link the machine in its thread." }),
};

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-cards-`);
	dirs.push(root);
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const page = newToken();
	const view = newToken();
	const answers: unknown[][] = [];
	const logs: Record<string, unknown>[] = [];
	const app = createApp({
		capability: memoryCapability(page, { now: Date.now() }, view).capability,
		store: memStore(),
		state: `${root}/state`,
		log: (event, data) => logs.push({ event, ...data }),
		hosts: [HOST],
		staticDir: `${root}/`,
		mirror: {
			list: () => Object.values(CARDS),
			answer: async (...a: unknown[]) => {
				answers.push(a);
				return { status: 200, body: { ok: true, choice: "B" } };
			},
		},
	});
	const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
		app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					host: HOST,
					...headers,
					...(method === "POST" ? { "content-type": "application/json", "x-decision-queue": "1" } : {}),
				},
				...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
			}),
		);
	return { app, page, view, answers, logs, send };
}
const tok = (k: string) => ({ [TOKEN_HEADER]: k });
const ORIGINS = [
	["no Origin", {}],
	["Origin: null (T3's frame)", { origin: "null" }],
	["the page's own Origin", { origin: ORIGIN }],
] as const;

describe("the view key answers a question card waiting in another thread", () => {
	for (const [label, origin] of ORIGINS) {
		test(`${label}: a choice and the fingerprint, through mirror.answer; recorded as the view key's; no cookie`, async () => {
			const s = setup();
			const q = CARDS.question;
			const r = await s.send(
				"POST",
				`/api/cards/${q.id}/answer`,
				{ ...tok(s.view), ...origin },
				{ choice: 1, sig: q.sig },
			);
			expect([r.status, await r.json(), r.headers.get("set-cookie")]).toEqual([200, { ok: true, choice: "B" }, null]);
			// the kinds it may answer go with it, so mirror.answer checks them again on the card it sends (waiting.test.ts)
			expect(s.answers).toEqual([[q.id, 1, q.sig, VIEW_KEY_CARD_TYPES]]);
			expect(s.logs.filter((l) => l.event === "card-answered")).toEqual([
				{ event: "card-answered", id: q.id, status: 200, key: "view" },
			]);
			if ("origin" in origin && origin.origin === "null") {
				expect(r.headers.get("access-control-allow-origin")).toBe("null");
				const pre = await s.send("OPTIONS", `/api/cards/${q.id}/answer`, { origin: "null" });
				expect(pre.status).toBe(204);
			}
		});
	}
});

describe("and nothing else about cards", () => {
	for (const kind of ["approval", "goal", "secret", "link"] as const) {
		for (const [label, origin] of ORIGINS) {
			test(`a${kind === "approval" ? "n" : ""} ${kind} card, ${label}: refused (403), never sent to its thread`, async () => {
				const s = setup();
				const c = CARDS[kind];
				const r = await s.send(
					"POST",
					`/api/cards/${c.id}/answer`,
					{ ...tok(s.view), ...origin },
					{ choice: 0, sig: c.sig },
				);
				expect([kind, r.status, r.headers.get("set-cookie")]).toEqual([kind, 403, null]);
				expect(s.answers).toEqual([]);
				expect(s.logs.filter((l) => l.event === "card-answered")).toEqual([]);
			});
		}
	}
	test("an approval's confirmation step is refused to the view key: no challenge, no session cookie", async () => {
		const s = setup();
		const a = CARDS.approval;
		for (const [, origin] of ORIGINS) {
			const r = await s.send(
				"POST",
				`/api/cards/${a.id}/confirm`,
				{ ...tok(s.view), ...origin },
				{ choice: 0, sig: a.sig },
			);
			const text = await r.text();
			expect([r.status, r.headers.get("set-cookie"), text.includes("challenge")]).toEqual([403, null, false]);
		}
		expect(s.logs.filter((l) => l.event === "card-confirmation-issued")).toEqual([]);
	});
	test("a field beyond the choice and the fingerprint is refused, and nothing is sent: a challenge, a note, a ruling", async () => {
		const s = setup();
		const q = CARDS.question;
		for (const extra of [{ challenge: "x" }, { note: "hi" }, { saveRuling: true }, { rulingWording: "always" }]) {
			const r = await s.send("POST", `/api/cards/${q.id}/answer`, tok(s.view), { choice: 0, sig: q.sig, ...extra });
			expect([Object.keys(extra)[0], r.status]).toEqual([Object.keys(extra)[0], 403]);
		}
		expect(s.answers).toEqual([]);
	});
	test("a card that is not listed: 404, nothing sent", async () => {
		const s = setup();
		const r = await s.send("POST", "/api/cards/C-0000000000ff/answer", tok(s.view), { choice: 0, sig: "x" });
		expect(r.status).toBe(404);
		expect(s.answers).toEqual([]);
	});
	test("the page key from a frame or with no Origin still answers no card, not even a question card", async () => {
		const s = setup();
		const q = CARDS.question;
		for (const origin of [{}, { origin: "null" }] as Record<string, string>[]) {
			const r = await s.send(
				"POST",
				`/api/cards/${q.id}/answer`,
				{ ...tok(s.page), ...origin },
				{ choice: 0, sig: q.sig },
			);
			expect(r.status).toBe(403);
		}
		expect(s.answers).toEqual([]);
	});
	test("the full page is unchanged: it answers a question card, and an approval still needs the server's confirmation", async () => {
		const s = setup();
		const same = { ...tok(s.page), origin: ORIGIN };
		const q = CARDS.question;
		expect((await s.send("POST", `/api/cards/${q.id}/answer`, same, { choice: 0, sig: q.sig })).status).toBe(200);
		const a = CARDS.approval;
		expect((await s.send("POST", `/api/cards/${a.id}/answer`, same, { choice: 0, sig: a.sig })).status).toBe(428);
		// an answer with no confirmation may reach only a card that needs none, checked again where it is sent (waiting.test.ts): the same race
		// the view key's answer closes, closed for the full page too
		expect(s.answers).toEqual([[q.id, 0, q.sig, UNCONFIRMED_CARD_TYPES]]);
	});
});

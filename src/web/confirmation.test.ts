/**
 * The approval confirm step is the server's. Answering an approval or a goal proposal takes two requests: one that
 * returns a single-use, expiring challenge bound to the card's fingerprint, the chosen decision and the browser session, and one that
 * consumes it. A request that skips the first, replays it, presents it late or for something else is refused, whatever sent it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "../core/adapter.ts";
import { CHALLENGE_TTL_MS } from "../core/challenge.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import { createWaiting } from "./waiting.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const card = (over: Partial<WaitingCard>): WaitingCard => ({ id: "C-0123456789ab", type: "approval", server: "fake", threadId: "t1", threadTitle: "Build", requestId: "r1", question: "Run this?", options: [{ label: "Approve once" }, { label: "Decline" }], answerable: true, sig: "sig-1", command: "rm -rf build", ...over });

/** The real card layer over the fake adapter, behind the real app. */
async function setup(cards: WaitingCard[] = [card({})]) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-confirm-`);
	dirs.push(root);
	const fake = createFakeAdapter();
	fake.cards = cards;
	const clock = { t: Date.parse("2026-11-12T12:00:00Z") };
	const mirror = createWaiting({ store: memStore(), servers: () => [{ server: { name: "fake", adapter: "fake" }, adapter: fake }], skipThreads: () => [], log: () => {} });
	await mirror.poll();
	const store = memStore();
	const app = createApp({ store, state: `${root}/state`, log: () => {}, hosts: [HOST], staticDir: root, mirror, now: () => clock.t });
	const send = (path: string, body: unknown, o: { cookie?: string; origin?: string } = {}) => app.fetch(new Request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}) }, body: JSON.stringify(body) }));
	const confirm = (id: string, body: unknown, cookie?: string) => send(`/api/cards/${id}/confirm`, body, { cookie });
	const answer = (id: string, body: unknown, cookie?: string) => send(`/api/cards/${id}/answer`, body, { cookie });
	/** Step one as the page does it: returns the challenge and the session cookie the server set. */
	async function ask(id: string, choice: number, sig: string, cookie?: string) {
		const r = await confirm(id, { choice, sig }, cookie);
		const set = r.headers.get("set-cookie");
		const body = await r.json();
		return { status: r.status, body, challenge: body.challenge as string, cookie: cookie ?? set?.split(";")[0], setCookie: set };
	}
	return { fake, store, app, clock, mirror, confirm, answer, ask };
}

describe("the direct-API bypass is refused", () => {
	test("an approval answered with just choice and sig (what the page used to send after its own tap) is refused and nothing reaches the backend", async () => {
		const s = await setup();
		const r = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1" });
		expect(r.status).toBe(428);
		expect((await r.json()).code).toBe("confirmation-missing");
		expect(s.fake.answers).toEqual([]);
		expect(s.mirror.list().map((c) => c.id)).toEqual(["C-0123456789ab"]);
	});

	test("a made-up challenge is refused", async () => {
		const s = await setup();
		const r = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: "ab".repeat(24) });
		expect(r.status).toBe(403);
		expect((await r.json()).code).toBe("confirmation-unknown");
		expect(s.fake.answers).toEqual([]);
	});

	test("a goal proposal is held to the same rule", async () => {
		const s = await setup([card({ id: "C-ffffffffffff", type: "goal", options: [{ label: "Send the /goal" }], command: "/goal Make PR 1 green." })]);
		expect((await s.answer("C-ffffffffffff", { choice: 0, sig: "sig-1" })).status).toBe(428);
		expect(s.fake.answers).toEqual([]);
		const { challenge, cookie } = await s.ask("C-ffffffffffff", 0, "sig-1");
		expect((await s.answer("C-ffffffffffff", { choice: 0, sig: "sig-1", challenge }, cookie)).status).toBe(200);
		expect(s.fake.answers).toHaveLength(1);
	});
});

describe("the two steps", () => {
	test("step one returns a challenge and sets the session cookie; step two with it answers once", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		expect(a.status).toBe(200);
		expect(a.body).toMatchObject({ ok: true, decision: "Approve once", expiresInMs: CHALLENGE_TTL_MS, expiresAt: s.clock.t + CHALLENGE_TTL_MS });
		expect(a.challenge).toMatch(/^[a-f0-9]{48}$/);
		expect(a.setCookie).toMatch(/^dq_session=[a-f0-9]{48}; Path=\/api\/cards\/; HttpOnly; SameSite=Strict/);
		// Nothing has been answered yet: asking is not answering.
		expect(s.fake.answers).toEqual([]);
		const r = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie);
		expect(r.status).toBe(200);
		expect(s.fake.answers.map((x) => [x.card.id, x.choice, x.sig])).toEqual([["C-0123456789ab", 0, "sig-1"]]);
	});

	test("a second ask in the same session reuses its cookie and replaces the first challenge", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		const b = await s.ask("C-0123456789ab", 0, "sig-1", a.cookie);
		expect(b.setCookie).toBeNull();
		expect(b.challenge).not.toBe(a.challenge);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie)).status).toBe(403);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: b.challenge }, a.cookie)).status).toBe(200);
	});

	test("a question card needs no confirmation: it is answered directly, and asking for one is refused", async () => {
		const s = await setup([card({ id: "C-aaaaaaaaaaaa", type: "question", options: [{ label: "Yes" }, { label: "No" }], command: undefined })]);
		expect((await s.confirm("C-aaaaaaaaaaaa", { choice: 0, sig: "sig-1" })).status).toBe(400);
		expect((await s.answer("C-aaaaaaaaaaaa", { choice: 1, sig: "sig-1" })).status).toBe(200);
		expect(s.fake.answers.map((x) => x.choice)).toEqual([1]);
	});
});

describe("a challenge is single-use, expiring, and bound", () => {
	test("a replayed challenge is refused (the first answer used it, though the backend could not be reached)", async () => {
		const s = await setup();
		s.fake.answerOutcome = { ok: false, kind: "unreachable", error: "could not reach T3", maybeSent: false };
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie)).status).toBe(502);
		expect(s.fake.answers).toHaveLength(1);
		const again = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie);
		expect(again.status).toBe(403);
		expect((await again.json()).code).toBe("confirmation-used");
		expect(s.fake.answers).toHaveLength(1);
	});

	test("an expired challenge is refused, even one second late, and works one second before", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		s.clock.t += CHALLENGE_TTL_MS;
		const late = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie);
		expect(late.status).toBe(410);
		expect((await late.json()).code).toBe("confirmation-expired");
		expect(s.fake.answers).toEqual([]);
		const b = await s.ask("C-0123456789ab", 0, "sig-1", a.cookie);
		s.clock.t += CHALLENGE_TTL_MS - 1000;
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: b.challenge }, a.cookie)).status).toBe(200);
	});

	test("a challenge for one decision cannot answer another", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 1, "sig-1"); // asked to Decline
		const r = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie); // presented to Approve
		expect(r.status).toBe(403);
		expect((await r.json()).code).toBe("confirmation-mismatch");
		expect(s.fake.answers).toEqual([]);
		// The refusal changed nothing: the challenge still works for what it was for.
		expect((await s.answer("C-0123456789ab", { choice: 1, sig: "sig-1", challenge: a.challenge }, a.cookie)).status).toBe(200);
	});

	test("a challenge for one card cannot answer another", async () => {
		const s = await setup([card({}), card({ id: "C-bbbbbbbbbbbb", requestId: "r2", command: "ls" })]);
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		const r = await s.answer("C-bbbbbbbbbbbb", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie);
		expect(r.status).toBe(403);
		expect(s.fake.answers).toEqual([]);
	});

	test("a challenge is bound to the card as it was shown: a card that changed between the two steps is not approved", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		// The command changed under the same card id: a new fingerprint.
		s.fake.cards = [card({ sig: "sig-2", command: "rm -rf /" })];
		await s.mirror.poll();
		// The old fingerprint is stale: refused by the card layer, and the challenge is spent.
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie)).status).toBe(409);
		expect(s.fake.answers).toEqual([]);
		// The new fingerprint with the old challenge is refused by the challenge.
		const b = await s.ask("C-0123456789ab", 0, "sig-1", a.cookie);
		expect(b.status).toBe(409);
		const fresh = await s.ask("C-0123456789ab", 0, "sig-2", a.cookie);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-2", challenge: a.challenge }, a.cookie)).status).toBe(403);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-2", challenge: fresh.challenge }, a.cookie)).status).toBe(200);
		expect(s.fake.answers.map((x) => x.sig)).toEqual(["sig-2"]);
	});

	test("a challenge is bound to the session: another browser, or none, cannot use it", async () => {
		const s = await setup();
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		for (const cookie of [undefined, `dq_session=${"c".repeat(48)}`, "dq_session=not-a-session"]) {
			const r = await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, cookie);
			expect([cookie, r.status]).toEqual([cookie, 403]);
		}
		expect(s.fake.answers).toEqual([]);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge }, a.cookie)).status).toBe(200);
	});
});

describe("what can never be answered stays unanswerable", () => {
	test("'always' is not a choice: an approval has two options, and no confirmation is issued for another", async () => {
		const s = await setup();
		for (const choice of [2, -1, 1.5, "always", null]) expect([choice, (await s.confirm("C-0123456789ab", { choice, sig: "sig-1" })).status]).toEqual([choice, 400]);
		expect((await s.confirm("C-0123456789ab", { choice: 0, sig: "sig-1", decision: "acceptForSession" })).status).toBe(200);
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1", challenge: a.challenge, decision: "acceptForSession" }, a.cookie);
		expect(s.fake.answers.map((x) => x.choice)).toEqual([0]);
	});

	for (const type of ["secret", "link"] as const) {
		test(`a ${type} request: no confirmation, no answer, whatever it is sent`, async () => {
			const s = await setup([card({ id: "C-eeeeeeeeeeee", type, answerable: false, why: "answer it in its thread", options: [], command: undefined })]);
			expect((await s.confirm("C-eeeeeeeeeeee", { choice: 0, sig: "sig-1" })).status).toBe(403);
			expect((await s.answer("C-eeeeeeeeeeee", { choice: 0, sig: "sig-1", challenge: "ab".repeat(24) })).status).toBe(403);
			expect(s.fake.answers).toEqual([]);
		});
	}

	test("an approval the card layer refused to make answerable stays refused at both steps", async () => {
		const s = await setup([card({ answerable: false, why: "no operate token", options: [] })]);
		expect((await s.confirm("C-0123456789ab", { choice: 0, sig: "sig-1" })).status).toBe(403);
		expect((await s.answer("C-0123456789ab", { choice: 0, sig: "sig-1" })).status).toBe(403);
	});
});

describe("an inline frame has no part in it", () => {
	test("both steps are refused from a null origin, and no challenge is issued", async () => {
		const s = await setup();
		expect((await s.app.fetch(new Request(`http://${HOST}/api/cards/C-0123456789ab/confirm`, { method: "POST", headers: { host: HOST, origin: "null", "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0, sig: "sig-1" }) }))).status).toBe(403);
		// Nothing was issued to it: the full page's own ask works as before, and starts a session of its own.
		const a = await s.ask("C-0123456789ab", 0, "sig-1");
		expect(a.status).toBe(200);
		expect(a.setCookie).not.toBeNull();
	});
});

/**
 * The paths of the queue page's app (src/web/app.ts) that the other web tests leave out: its routes' refusals, an answer's
 * validation, the batch accept's skip reasons, and the logged failures of a direct send's bookkeeping. They pin what the
 * handler answers today, so the handler can be split without changing it.
 */

import { describe, expect, test } from "bun:test";
import { getQuestion } from "../core/questions.ts";
import { addInForce, readRulings } from "../core/rulings.ts";
import { useWebAppPathsFixtures } from "../testing/web-app-paths-fixtures.ts";

const { question, setup, read } = useWebAppPathsFixtures();

describe("routes that refuse", () => {
	test("a POST to an unknown API path, a missing JSON body, and an unknown page are 404, 400 and 404", async () => {
		const s = setup();
		expect(await read(await s.post("/api/nope", {}))).toEqual({ status: 404, body: { error: "not found" } });
		expect(await read(await s.call("POST", "/api/items/Q-abcd/answer"))).toEqual({
			status: 400,
			body: { error: "expected a JSON body" },
		});
		expect(await read(await s.get("/nope"))).toEqual({ status: 404, body: { error: "not found" } });
		expect(await read(await s.call("PUT", "/api/queue", {}))).toEqual({ status: 404, body: { error: "not found" } });
	});

	test("a JSON array is not a JSON body: it is refused (400) on every body route, and nothing changes", async () => {
		const s = setup();
		s.asked(question("Q-abcd"));
		for (const path of ["/api/items/Q-abcd/answer", "/api/items/Q-abcd/snooze", "/api/accept-all", "/api/rulings"]) {
			for (const body of [[], [{ choice: 0 }]]) {
				expect(await read(await s.post(path, body))).toEqual({ status: 400, body: { error: "expected a JSON body" } });
			}
		}
		expect(getQuestion(s.real, "Q-abcd")?.status).toBe("open");
		expect(readRulings(s.real)).toEqual([]);
	});

	test("a card answer on a page with no mirror is 404", async () => {
		const s = setup();
		expect((await read(await s.post("/api/cards/c1/answer", { choice: 0 }))).status).toBe(404);
		expect((await read(await s.post("/api/cards/c1/confirm", { choice: 0 }))).status).toBe(404);
	});

	test("a path with a broken percent escape names no item and no evidence", async () => {
		const s = setup();
		expect(await read(await s.get("/api/items/%E0%A4%A"))).toEqual({ status: 404, body: { error: "no such item" } });
		expect(await read(await s.get("/evidence/%E0%A4%A/x"))).toEqual({ status: 404, body: { error: "not found" } });
		expect(await read(await s.get("/evidence/Q-abcd"))).toEqual({ status: 404, body: { error: "not found" } });
	});

	test("not-now sets an open item aside once, and an unknown or already set-aside item is 404 only when closed", async () => {
		const s = setup();
		s.asked(question("Q-abcd"));
		expect(await read(await s.post("/api/items/Q-abcd/not-now", {}))).toEqual({ status: 200, body: { ok: true } });
		expect(await read(await s.post("/api/items/Q-abcd/not-now", {}))).toEqual({ status: 200, body: { ok: true } });
		expect(await read(await s.post("/api/items/Q-zzzz/not-now", {}))).toEqual({
			status: 404,
			body: { error: "no open item" },
		});
		expect((await read(await s.post("/api/items/Q-abcd/answer", { choice: 0 }))).status).toBe(200);
		expect(await read(await s.post("/api/items/Q-abcd/not-now", {}))).toEqual({
			status: 404,
			body: { error: "no open item" },
		});
	});
});

describe("ruling actions", () => {
	const withRulings = () => {
		const s = setup();
		for (const w of ["one", "two", "three", "four"])
			addInForce(s.real, { words: `words ${w}`, decides: `decides ${w}`, source: "chat", how: "stated" });
		return { s, ids: readRulings(s.real).map((r) => r.id) };
	};

	test("confirm, edit, once and retire change the ruling and are logged; any other action is 404", async () => {
		const { s, ids } = withRulings();
		const [a, b, c, d] = ids as [string, string, string, string];
		const edited = await read(await s.post(`/api/rulings/${a}/edit`, { decides: "new wording" }));
		expect(edited.status).toBe(200);
		expect((edited.body as { ruling: { decides: string } }).ruling.decides).toBe("new wording");
		expect((await read(await s.post(`/api/rulings/${b}/confirm`, {}))).status).toBe(200);
		const once = await read(await s.post(`/api/rulings/${c}/once`, {}));
		expect((once.body as { ruling: { status: string; retiredHow: string } }).ruling).toMatchObject({
			status: "retired",
			retiredHow: "only this once",
		});
		const retired = await read(await s.post(`/api/rulings/${d}/retire`, {}));
		expect((retired.body as { ruling: { status: string; retiredHow: string } }).ruling).toMatchObject({
			status: "retired",
			retiredHow: "retired",
		});
		expect(await read(await s.post(`/api/rulings/${a}/shred`, {}))).toEqual({
			status: 404,
			body: { error: "unknown action" },
		});
		expect(s.logs.filter((l) => l.event === "ruling-changed").map((l) => l.data)).toEqual([
			{ id: a, action: "edit", key: "page" },
			{ id: b, action: "confirm", key: "page" },
			{ id: c, action: "once", key: "page" },
			{ id: d, action: "retire", key: "page" },
		]);
	});

	test("a change the store refuses is 400 with its reason", async () => {
		const { s } = withRulings();
		expect(await read(await s.post("/api/rulings/R999/retire", {}))).toEqual({
			status: 400,
			body: { error: "no ruling R999" },
		});
		expect(await read(await s.post("/api/rulings/R1/edit", { decides: "  " }))).toEqual({
			status: 400,
			body: { error: "empty wording" },
		});
		expect(await read(await s.post("/api/rulings/R1/edit", {}))).toEqual({
			status: 400,
			body: { error: "empty wording" },
		});
	});
});

describe("answering", () => {
	test("a choice that is not one of the options is 400, whatever it is made of", async () => {
		const s = setup();
		s.asked(question("Q-abcd"));
		for (const choice of [2, -1, 1.5, "0", null, undefined]) {
			const r = await read(await s.post("/api/items/Q-abcd/answer", { choice }));
			expect(r).toEqual({ status: 400, body: { error: "choose one of the options" } });
		}
		expect((await read(await s.post("/api/items/Q-abcd/answer", { choice: 1 }))).status).toBe(200);
	});

	test("an unknown item is 404, a secret or a card pointer 400 or 409 with where to act", async () => {
		const s = setup();
		s.asked(question("Q-secr", { secret: true }));
		s.asked(question("Q-card", { cardRequest: "req-1" }));
		expect(await read(await s.post("/api/items/Q-none/answer", { choice: 0 }))).toEqual({
			status: 404,
			body: { error: "no such item" },
		});
		expect(await read(await s.post("/api/items/Q-secr/answer", { choice: 0 }))).toEqual({
			status: 400,
			body: { error: "a secret is entered in its own thread, never on this page" },
		});
		const card = await read(await s.post("/api/items/Q-card/answer", { choice: 0 }));
		expect(card.status).toBe(409);
		expect((card.body as { error: string }).error).toContain("act on the card itself");
	});

	test("a note is trimmed and cut to 4000 characters; a blank one is dropped", async () => {
		const s = setup();
		s.asked(question("Q-aaaa"));
		s.asked(question("Q-bbbb"));
		await s.post("/api/items/Q-aaaa/answer", { choice: 0, note: `  ${"x".repeat(5000)}  ` });
		await s.post("/api/items/Q-bbbb/answer", { choice: 0, note: "   " });
		const notes = (await read(await s.get("/api/recent"))).body as {
			items: { id: string; answer?: { note?: string } }[];
		};
		const by = Object.fromEntries(notes.items.map((i) => [i.id, i.answer?.note]));
		expect(by["Q-aaaa"]).toBe("x".repeat(4000));
		expect(by["Q-bbbb"]).toBeUndefined();
	});

	test("saving a ruling needs wording, and a proposed expiry that is bad or past refuses the answer", async () => {
		const s = setup();
		s.asked(question("Q-nowd"));
		s.asked(question("Q-badx", { proposedRuling: "Always do this", proposedExpires: "soon" }));
		s.asked(question("Q-past", { proposedRuling: "Always do this", proposedExpires: "2020-01-01" }));
		s.asked(question("Q-good", { proposedRuling: "Always do this", proposedExpires: "2999-01-01" }));
		expect(await read(await s.post("/api/items/Q-nowd/answer", { choice: 0, saveRuling: true }))).toEqual({
			status: 400,
			body: { error: "there is no ruling wording to save" },
		});
		const bad = await read(await s.post("/api/items/Q-badx/answer", { choice: 0, saveRuling: true }));
		expect(bad.status).toBe(400);
		expect((bad.body as { error: string }).error).toMatch(/^the proposed ruling's expiry must be an ISO date/);
		expect(await read(await s.post("/api/items/Q-past/answer", { choice: 0, saveRuling: true }))).toEqual({
			status: 400,
			body: { error: "the proposed ruling expired on 2020-01-01: save it without a ruling, or write a new one" },
		});
		const ok = await read(await s.post("/api/items/Q-good/answer", { choice: 1, note: "why", saveRuling: true }));
		expect(ok).toMatchObject({
			status: 200,
			body: { ok: true, id: "Q-good", choice: "B", to: "steward", recorded: true, wake: "queued" },
		});
		expect(readRulings(s.real).map((r) => r.decides)).toEqual(["Always do this"]);
	});

	test("an inline frame may not carry a ruling field or a note that is not text", async () => {
		const s = setup();
		s.asked(question("Q-abcd", { proposedRuling: "Always do this" }));
		const inline = (body: unknown) => s.call("POST", "/api/items/Q-abcd/answer", body, { origin: "null" }).then(read);
		expect(await inline({ choice: 0, saveRuling: true, rulingWording: "x" })).toEqual({
			status: 403,
			body: {
				error:
					'an inline frame may only choose an option and add a note, not "saveRuling", "rulingWording": answer on the full page',
			},
		});
		expect(await inline({ choice: 0, note: 5 })).toEqual({ status: 400, body: { error: "note must be text" } });
		expect((await inline({ choice: 0, note: "fine" })).status).toBe(200);
	});
});

describe("accepting a batch", () => {
	test("ids must be a list, and each id is answered with its recommendation or skipped with its reason", async () => {
		const s = setup();
		s.asked(question("Q-good"));
		s.asked(question("Q-only", { kind: "only-you" }));
		s.asked(question("Q-secr", { secret: true }));
		s.asked(question("Q-norc", { recommended: undefined }));
		s.asked(question("Q-done"));
		await s.post("/api/items/Q-done/answer", { choice: 1 });
		expect(await read(await s.post("/api/accept-all", { ids: "Q-good" }))).toEqual({
			status: 400,
			body: { error: "ids must be a list" },
		});
		const r = await read(
			await s.post("/api/accept-all", { ids: ["Q-good", "Q-only", "Q-secr", "Q-norc", "Q-done", "Q-none", 7] }),
		);
		expect(r).toEqual({
			status: 200,
			body: {
				answered: ["Q-good"],
				skipped: [
					{ id: "Q-only", why: "only you can answer this one" },
					{ id: "Q-secr", why: "a secret" },
					{ id: "Q-norc", why: "no recommendation" },
					{ id: "Q-done", why: "already answered" },
					{ id: "Q-none", why: "no such item" },
					{ id: "7", why: "no such item" },
				],
			},
		});
	});
});

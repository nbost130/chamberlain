/**
 * What the VIEW key may do, against the real handler (createApp) with a real capability: exactly the allowlist in ./view-key.ts (three reads, answer,
 * snooze, un-snooze, direction, dismiss) from any origin or none, nothing else; the page key keeps everything it had; and every write records which key made it.
 */

import { describe, expect, test } from "bun:test";
import { obsFor } from "../core/log.ts";
import { getQuestion } from "../core/questions.ts";
import { readClaim } from "../core/questions-claim.ts";
import { readRulings } from "../core/rulings.ts";
import { dataOf } from "../testing/obs.ts";
import type { S } from "../testing/web-view-key-fixtures.ts";
import { useWebViewKeyFixtures } from "../testing/web-view-key-fixtures.ts";
import { authorityOf, keyUsed, mayDo, VIEW_KEY_READS, VIEW_KEY_WRITES, viewKeyVerdict } from "./view-key.ts";

const { ORIGIN, LATER, setup, tok, WRITES, REFUSED } = useWebViewKeyFixtures();

describe("the allowlist is one explicit list", () => {
	test("three reads and five writes, and nothing else", () => {
		expect([...VIEW_KEY_READS].sort()).toEqual(["/api/queue", "/api/recent", "/api/rulings"]);
		expect([...VIEW_KEY_WRITES]).toEqual(["answer", "snooze", "unsnooze", "direction", "dismiss"]);
	});
	test("the verdict on each route: the five writes and three reads pass; not-now, batch, rulings, cards and an item's read do not", () => {
		for (const w of VIEW_KEY_WRITES) expect(viewKeyVerdict("POST", `/api/items/Q-abcd/${w}`)).toBe(w);
		for (const r of VIEW_KEY_READS) expect(viewKeyVerdict("GET", r)).toBe("read");
		for (const [m, p] of [
			["POST", "/api/items/Q-abcd/not-now"],
			["POST", "/api/accept-all"],
			["POST", "/api/rulings/R1/confirm"],
			["POST", "/api/cards/C-0123456789ab/answer"],
			["POST", "/api/cards/C-0123456789ab/confirm"],
			["POST", "/api/items/not-an-id/snooze"],
			["POST", "/api/items/Q-abcd/snooze/x"],
			["GET", "/api/items/Q-abcd"],
			["GET", "/evidence/Q-abcd/shot.png"],
			["GET", "/"],
			["PUT", "/api/items/Q-abcd/snooze"],
			["DELETE", "/api/items/Q-abcd/dismiss"],
			["OPTIONS", "/api/items/Q-abcd/not-now"],
			["OPTIONS", "/api/accept-all"],
		] as const)
			expect([m, p, viewKeyVerdict(m, p)]).toEqual([m, p, "refuse"]);
		expect(viewKeyVerdict("OPTIONS", "/api/items/Q-abcd/snooze")).toBe("preflight");
	});
	test("the authorities: full does every action, the view key its five, the page key from a frame only the plain answer", () => {
		const all = ["answer", "snooze", "unsnooze", "direction", "dismiss", "not-now", "accept-all", "ruling"];
		expect(all.filter((a) => mayDo("full", a))).toEqual(all);
		expect(all.filter((a) => mayDo("view", a))).toEqual(["answer", "snooze", "unsnooze", "direction", "dismiss"]);
		expect(all.filter((a) => mayDo("restricted", a))).toEqual(["answer"]);
		expect([authorityOf(false, true), authorityOf(true, true), authorityOf(true, false)]).toEqual([
			"full",
			"view",
			"restricted",
		]);
		expect([keyUsed("full"), keyUsed("view"), keyUsed("restricted")]).toEqual(["page", "view", "page"]);
	});
});

for (const [label, origin] of [
	["no Origin", {}],
	["Origin: null (T3's frame)", { origin: "null" }],
	["the page's own Origin", { origin: ORIGIN }],
] as const) {
	describe(`the view key, ${label}`, () => {
		const h = (s: S) => ({ ...tok(s.view), ...origin });
		for (const [action, path, body] of WRITES("Q-abcd")) {
			test(`${action} works, and is recorded as made with the view key`, async () => {
				const s = setup();
				const r = await s.send("POST", path, h(s), body);
				expect([action, r.status]).toEqual([action, 200]);
				if ("origin" in origin && origin.origin === "null")
					expect(r.headers.get("access-control-allow-origin")).toBe("null");
				await s.app.idle();
				const q = getQuestion(s.store, "Q-abcd")!;
				if (action === "snooze") {
					expect(q.status).toBe("open");
					expect(q.snooze).toMatchObject({ until: LATER, key: "view", active: true });
					expect(s.logs.filter((l) => l.event === "snoozed")).toMatchObject([{ key: "view" }]);
				} else {
					expect(readClaim(s.store, "Q-abcd")?.answer).toMatchObject({ by: "page", key: "view" });
					expect(s.store.wakes.rows("all")).toHaveLength(1);
					const event = action === "answer" ? "answered" : action === "direction" ? "directed" : "dismissed";
					expect(s.logs.filter((l) => l.event === event)).toMatchObject([{ key: "view" }]);
				}
				expect(s.logs.find((l) => l.event !== "wake-queued")).toMatchObject({ key: "view" });
				expect(JSON.stringify([s.logs, q])).not.toContain(s.view);
			});
		}
		// The view key's answer is a choice and nothing else: a note is a Direction, or written on the full page. Refused before anything is written.
		for (const extra of [
			{ note: "an unapproved note" },
			{ note: "" },
			{ note: null },
			{ note: "  " },
			{ note: "x", saveRuling: false },
			{ rulingWording: "x" },
			{ by: "batch" },
			{ key: "page" },
			{ id: "Q-other" },
		]) {
			test(`an answer with ${JSON.stringify(extra)} is refused (403) and writes nothing`, async () => {
				const s = setup();
				const r = await s.send("POST", "/api/items/Q-efgh/answer", h(s), { choice: 0, ...extra });
				expect([JSON.stringify(extra), r.status]).toEqual([JSON.stringify(extra), 403]);
				await s.app.idle();
				expect(readClaim(s.store, "Q-efgh")).toBeUndefined();
				expect(getQuestion(s.store, "Q-efgh")!.status).toBe("open");
				expect(s.store.wakes.rows("all")).toEqual([]);
				expect(readRulings(s.store)).toEqual([]);
			});
		}
		test("a choice alone is answered, and the claim carries no note", async () => {
			const s = setup();
			expect((await s.send("POST", "/api/items/Q-efgh/answer", h(s), { choice: 1 })).status).toBe(200);
			const answer = readClaim(s.store, "Q-efgh")?.answer;
			expect(answer).toMatchObject({ choice: 1, key: "view" });
			expect(answer).not.toHaveProperty("note");
		});
		test("un-snooze brings a snoozed item back at once, recorded as the view key's; an item that is not snoozed is refused (409)", async () => {
			const s = setup();
			expect((await s.send("POST", "/api/items/Q-abcd/unsnooze", h(s), {})).status).toBe(409);
			expect((await s.send("POST", "/api/items/Q-abcd/snooze", h(s), { until: LATER })).status).toBe(200);
			expect(getQuestion(s.store, "Q-abcd")!.snooze?.active).toBe(true);
			expect((await s.send("POST", "/api/items/Q-abcd/unsnooze", h(s), {})).status).toBe(200);
			await s.app.idle();
			expect(getQuestion(s.store, "Q-abcd")).toMatchObject({ status: "open" });
			expect(getQuestion(s.store, "Q-abcd")!.snooze?.active).not.toBe(true);
			expect(s.logs.filter((l) => l.event === "unsnoozed")).toMatchObject([{ id: "Q-abcd", key: "view" }]);
			expect(JSON.stringify(s.logs)).not.toContain(s.view);
		});
		test("a snoozed item is dismissed straight from the snoozed list: one request, recorded as the view key's, and its snooze ends", async () => {
			const s = setup();
			expect((await s.send("POST", "/api/items/Q-abcd/snooze", h(s), { until: LATER })).status).toBe(200);
			expect((await s.send("POST", "/api/items/Q-abcd/dismiss", h(s), {})).status).toBe(200);
			await s.app.idle();
			expect(getQuestion(s.store, "Q-abcd")).toMatchObject({ status: "dismissed" });
			expect(readClaim(s.store, "Q-abcd")?.answer).toMatchObject({ kind: "dismissed", key: "view" });
		});
		test("the answer's ledger row says the view key too, and a ruling field is still refused", async () => {
			const s = setup();
			expect((await s.send("POST", "/api/items/Q-efgh/answer", h(s), { choice: 0, saveRuling: true })).status).toBe(
				403,
			);
			expect((await s.send("POST", "/api/items/Q-efgh/answer", h(s), { choice: 0 })).status).toBe(200);
			await s.app.idle();
			expect(dataOf(obsFor(s.store), "question.answered")).toMatchObject([{ key: "view", by: "page" }]);
			expect(readRulings(s.store)).toEqual([]);
		});
		for (const [method, path, body] of REFUSED) {
			test(`${method} ${path} ${body ? JSON.stringify(body).slice(0, 40) : ""} is refused (403 or 401) and nothing changes`, async () => {
				const s = setup();
				// a snoozed item, so a refused route has something to change if it were let through
				expect((await s.send("POST", "/api/items/Q-abcd/snooze", h(s), { until: LATER })).status).toBe(200);
				const before = JSON.stringify([
					getQuestion(s.store, "Q-abcd"),
					s.store.wakes.rows("all"),
					readRulings(s.store),
				]);
				const r = await s.send(method, path, h(s), body);
				expect([method, path, [401, 403].includes(r.status)]).toEqual([method, path, true]);
				const text = await r.text();
				expect(text).not.toContain("PNGBYTES");
				expect(text).not.toContain("Question Q-");
				await s.app.idle();
				expect(JSON.stringify([getQuestion(s.store, "Q-abcd"), s.store.wakes.rows("all"), readRulings(s.store)])).toBe(
					before,
				);
				expect(s.cardAnswers).toEqual([]);
			});
		}
		test("`?k=<view key>` on any write or page is refused and sets no cookie", async () => {
			const s = setup();
			for (const p of ["/api/items/Q-abcd/snooze", "/", "/api/queue"]) {
				const r = await s.send(
					p === "/" || p === "/api/queue" ? "GET" : "POST",
					`${p}?k=${encodeURIComponent(s.view)}`,
					origin,
					{
						until: LATER,
					},
				);
				// a null-origin frame with no header key is refused at the origin gate (403), the rest at the key gate (401): never let in, no cookie
				expect([p, [401, 403].includes(r.status), r.headers.get("set-cookie")]).toEqual([p, true, null]);
			}
		});
	});
}

describe("preflight, from T3's null-origin frame", () => {
	test("the five writes and the reads get the grant-nothing 204; every other route is refused with no CORS", async () => {
		const s = setup();
		for (const p of [
			"/api/queue",
			"/api/items/Q-abcd/answer",
			"/api/items/Q-abcd/snooze",
			"/api/items/Q-abcd/unsnooze",
			"/api/items/Q-abcd/direction",
			"/api/items/Q-abcd/dismiss",
		]) {
			const r = await s.send("OPTIONS", p, { origin: "null" });
			expect([p, r.status, r.headers.get("access-control-allow-origin")]).toEqual([p, 204, "null"]);
		}
		for (const p of ["/api/items/Q-abcd/not-now", "/api/accept-all", "/api/rulings/R1/retire"]) {
			const r = await s.send("OPTIONS", p, { origin: "null" });
			expect([p, r.status, r.headers.get("access-control-allow-origin")]).toEqual([p, 403, null]);
		}
	});
});

describe("the page key keeps everything it has", () => {
	test("the page's own cookie does every item action, not-now, a batch and a ruling, each recorded as the page's", async () => {
		const s = setup();
		const link = await s.send("GET", `/?k=${encodeURIComponent(s.page)}`);
		const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0]!;
		const h = { cookie, origin: ORIGIN };
		const ok = async (path: string, body: unknown) =>
			expect([path, (await s.send("POST", path, h, body)).status]).toEqual([path, 200]);
		await ok("/api/items/Q-abcd/snooze", { until: LATER });
		expect(getQuestion(s.store, "Q-abcd")!.snooze?.key).toBe("page");
		await ok("/api/items/Q-abcd/unsnooze", {});
		await ok("/api/items/Q-abcd/direction", { note: "go" });
		await ok("/api/items/Q-efgh/dismiss", {});
		await ok("/api/items/Q-ijkl/not-now", {});
		await ok("/api/items/Q-mnop/answer", { choice: 0, saveRuling: true, rulingWording: "Lead with photos" });
		expect(readClaim(s.store, "Q-abcd")?.answer).toMatchObject({ kind: "direction", key: "page" });
		expect(readClaim(s.store, "Q-efgh")?.answer).toMatchObject({ kind: "dismissed", key: "page" });
		expect(readClaim(s.store, "Q-mnop")?.answer).toMatchObject({ key: "page" });
		const id = readRulings(s.store)[0]!.id;
		await ok(`/api/rulings/${id}/once`, {});
		await ok("/api/accept-all", { ids: ["Q-qrst"] });
		await s.app.idle();
		expect(s.logs.filter((l) => l.event === "snoozed")).toMatchObject([{ key: "page" }]);
		expect(s.logs.filter((l) => l.event === "unsnoozed")).toMatchObject([{ key: "page" }]);
	});
	test("the page key from its own origin snoozes too; with no Origin or from a frame it still gets only the old list", async () => {
		const s = setup();
		const same = await s.send("POST", "/api/items/Q-abcd/snooze", { ...tok(s.page), origin: ORIGIN }, { until: LATER });
		expect(same.status).toBe(200);
		for (const h of [tok(s.page), { ...tok(s.page), origin: "null" }])
			for (const a of ["snooze", "direction", "dismiss", "unsnooze"])
				expect([a, (await s.send("POST", `/api/items/Q-efgh/${a}`, h, { until: LATER, note: "n" })).status]).toEqual([
					a,
					403,
				]);
		expect(getQuestion(s.store, "Q-efgh")!.status).toBe("open");
		expect(readClaim(s.store, "Q-efgh")).toBeUndefined();
	});
});

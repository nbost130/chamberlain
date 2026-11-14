/**
 * One item answered on the page gives exactly one wake, however often it is answered, restarted or retried. Every
 * "process" here is built fresh from the same database file, with nothing carried over in memory: the page is createApp, as web/server.ts
 * wires it, beside the daemon's relay; the claim in the `claims` table and its outbox row hold the one wake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, getQuestion, type Question } from "../core/questions.ts";
import { claimWake, pageClaim, readClaims, wokenBy } from "../core/questions-claim.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath } from "../core/store.ts";
import { openCapability } from "../testing/capability.ts";
import { testRelay } from "../testing/relay.ts";
import { fetchWake } from "../testing/wake.ts";
import { createApp } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3790";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const item = (id: string): Question => ({
	id,
	kind: "product",
	title: "Lead the onboarding with a photo?",
	context: "Two layouts tested.",
	options: [{ label: "Photo first" }, { label: "Text first" }],
	recommended: 0,
	thread: "Mobile app",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-09T10:00:00.000Z",
});

/** One database file, one webhook that counts what it accepted, and fresh processes (each with its own connection) on demand. */
function world(status: () => number = () => 202) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-onewake-`);
	dirs.push(root);
	const state = `${root}/state`;
	const accepted: { deliveryId: string; message: string }[] = [];
	let code = status;
	const webhook = (async (_u: string, init: RequestInit) => {
		const s = code();
		if (s < 300) accepted.push(JSON.parse(String(init.body)));
		return new Response(null, { status: s });
	}) as unknown as typeof fetch;
	const wake = fetchWake(() => "http://webhook.test/wake", webhook);

	/** A fresh process's connection to the one database. */
	const store = () => openStore(dbPath(state));
	const shared = store();
	/** A fresh page, with the daemon's relay beside it unless `daemon` is false (the daemon is not running). */
	function page(daemon = true) {
		const own = store();
		const { drain } = testRelay(own, wake);
		const ui = createApp({
			capability: openCapability(),
			store: own,
			state,
			log: () => {},
			hosts: [HOST],
			staticDir: root,
		});
		const app = {
			...ui,
			idle: async () => {
				await ui.idle();
				if (daemon) await drain();
			},
		};
		const answer = async (id: string, choice: number) => {
			const r = await app.fetch(
				new Request(`http://${HOST}/api/items/${id}/answer`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1" },
					body: JSON.stringify({ choice }),
				}),
			);
			await app.idle();
			return r.status;
		};
		const tick = async () => {
			await ui.recover();
			if (daemon) await drain();
		};
		return { answer, tick, app };
	}
	const wakesFor = (id: string) => accepted.filter((p) => p.message.includes(id));
	return {
		state,
		store: shared,
		accepted,
		page,
		wakesFor,
		setStatus: (s: () => number) => {
			code = s;
		},
	};
}

const first = {
	choice: 0,
	label: "Photo first",
	by: "page" as const,
	t: new Date().toISOString(),
	deliveryId: "answer:item:Q-abcd",
};

describe("one wake per item", () => {
	test("answered once, then answered again and restarted: one wake, and the second answer is refused", async () => {
		const w = world();
		askQuestion(w.store, item("Q-abcd"));
		expect(await w.page().answer("Q-abcd", 0)).toBe(200);
		// A fresh page process, same disk, sees the item answered.
		expect(await w.page().answer("Q-abcd", 1)).toBe(409);
		await w.page().tick();
		await w.page().tick();
		expect(w.wakesFor("Q-abcd")).toHaveLength(1);
		expect(w.accepted).toHaveLength(1);
		expect(w.accepted[0]!.deliveryId).toBe("answer:item:Q-abcd");
	});

	test("the daemon is down when the page answers, both restart: one wake, recorded as delivered", async () => {
		const w = world(() => 503);
		askQuestion(w.store, item("Q-abcd"));
		expect(await w.page(false).answer("Q-abcd", 0)).toBe(200);
		expect(w.accepted).toHaveLength(0);
		w.setStatus(() => 202);
		await w.page().tick();
		await w.page().tick();
		expect(w.wakesFor("Q-abcd")).toHaveLength(1);
		expect(getQuestion(w.store, "Q-abcd")!.delivered).toBe(true);
	});

	test("a claim with no outbox row (an older page's): the restart writes the one wake from the claim", async () => {
		const w = world();
		askQuestion(w.store, item("Q-abcd"));
		// The dying process: the claim committed (with the whole wake in it, and the answer), and nothing after it was done.
		claimWake(w.store, pageClaim(item("Q-abcd"), first));
		expect(getQuestion(w.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: false });
		expect(await w.page().answer("Q-abcd", 1)).toBe(409);
		// A fresh page: no request, no memory. Only the ledger.
		await w.page().tick();
		await w.page().tick();
		expect(w.accepted.map((p) => p.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(getQuestion(w.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: true });
		expect(w.wakesFor("Q-abcd")).toHaveLength(1);
	});

	test("a refused answer never claims the item, so a later valid answer still sends its wake", async () => {
		const w = world();
		askQuestion(w.store, item("Q-abcd"));
		const p = w.page();
		// The item has no proposed ruling, so ticking "save as a ruling" with no wording is refused.
		const r = await p.app.fetch(
			new Request(`http://${HOST}/api/items/Q-abcd/answer`, {
				method: "POST",
				headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1" },
				body: JSON.stringify({ choice: 0, saveRuling: true }),
			}),
		);
		expect(r.status).toBe(400);
		await p.app.idle();
		expect(wokenBy(w.store, "Q-abcd")).toBeUndefined();
		expect(readClaims(w.store)).toEqual([]);
		expect(w.store.rulings.list()).toEqual([]);
		expect(await p.answer("Q-abcd", 1)).toBe(200);
		expect(w.wakesFor("Q-abcd")).toHaveLength(1);
	});

	test("two items stay independent", async () => {
		const w = world();
		askQuestion(w.store, item("Q-aaaa"));
		askQuestion(w.store, item("Q-bbbb"));
		expect(await w.page().answer("Q-aaaa", 0)).toBe(200);
		expect(await w.page().answer("Q-bbbb", 1)).toBe(200);
		expect(w.wakesFor("Q-aaaa")).toHaveLength(1);
		expect(w.wakesFor("Q-bbbb")).toHaveLength(1);
		expect(w.accepted).toHaveLength(2);
	});
});

test("the claim is first come, first served, and every later claimant gets the winner's claim back", () => {
	const w = world();
	for (const id of ["Q-abcd", "Q-efgh"]) askQuestion(w.store, item(id));
	expect(claimWake(w.store, pageClaim(item("Q-abcd"), first)).won).toBe(true);
	const lost = claimWake(w.store, pageClaim(item("Q-abcd"), { ...first, choice: 1, label: "Text first" }));
	expect(lost.won).toBe(false);
	expect(lost.claim).toMatchObject({
		owner: "page",
		deliveryId: "answer:item:Q-abcd",
		answer: { label: "Photo first" },
	});
	expect(claimWake(w.store, pageClaim(item("Q-abcd"), first)).won).toBe(false);
	expect(claimWake(w.store, pageClaim(item("Q-efgh"), { ...first, deliveryId: "answer:item:Q-efgh" })).won).toBe(true);
	expect(() => claimWake(w.store, { ...pageClaim(item("Q-abcd"), first), item: "Q-nope1" })).toThrow(/no item/);
	expect(readClaims(w.store).map((c) => c.item)).toEqual(["Q-abcd", "Q-efgh"]);
});

test("a claim won by another process's connection is the winner for every process: the unique key, not memory, decides", async () => {
	const w = world();
	askQuestion(w.store, item("Q-abcd"));
	const other = openStore(dbPath(w.state));
	expect(claimWake(other, pageClaim(item("Q-abcd"), first)).won).toBe(true);
	expect(claimWake(w.store, pageClaim(item("Q-abcd"), { ...first, label: "Text first", choice: 1 })).won).toBe(false);
	expect(await w.page().answer("Q-abcd", 1)).toBe(409);
});

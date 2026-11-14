/**
 * The "one item system" guarantee, tested by what the system DOES rather than how its source is spelled.
 * src/architecture.test.ts scans for known second mechanisms; a scan can only find what it knows to look for, and it let an in-memory
 * card-answer map with an expiry through. These tests are the backstop: each states an invariant about the database and breaks the
 * way a second, in-memory mechanism would. Two "processes" are two connections to one database file (as the daemon and the page are);
 * a "restart" is a fresh connection and fresh objects over the same file.
 *
 *   - A card answered once is answered once, from either page process, concurrently or after a restart.
 *   - A question answered once is answered once, from either page process, concurrently or after a restart.
 *   - An event that woke the Steward once does not wake it again from a second process or after a restart.
 *   - A sweep finding that notified once does not notify again after a restart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "./core/adapter.ts";
import { createEngine } from "./core/engine.ts";
import { askQuestion, getQuestion, type Question } from "./core/questions.ts";
import { evaluateSource, recordEvaluation } from "./core/source.ts";
import { openStore } from "./core/sqlite-store.ts";
import { createApp } from "./web/app.ts";
import { createWaiting } from "./web/waiting.ts";
import { createFakeAdapter, type FakeAdapter } from "./testing/fake-adapter.ts";
import { noAlert } from "./testing/alert.ts";
import { testRelayLock } from "./testing/lock.ts";
import type { Store } from "./core/store.ts";
import { openCapability } from "./testing/capability.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const dirs: string[] = [];
const stores: Store[] = [];
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const s of stoppers.splice(0)) await s();
	for (const s of stores.splice(0)) {
		try {
			s.close();
		} catch {
			/* closed */
		}
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-inv-`);
	dirs.push(d);
	return d;
};
/** One more connection to the database file: another process, or the same one after a restart. */
const connect = (dir: string) => {
	const s = openStore(`${dir}/chamberlain.db`);
	stores.push(s);
	return s;
};

// ---- cards -----------------------------------------------------------------------------------------

const card: WaitingCard = {
	id: "C-0123456789ab",
	type: "question",
	server: "fake",
	threadId: "t1",
	threadTitle: "Build",
	requestId: "r1",
	question: "Merge?",
	options: [{ label: "Yes" }, { label: "No" }],
	answerable: true,
	sig: "sig-1",
};

/** A page process over the shared database: its own card layer and its own adapter handle, answering slowly so two of them really overlap. */
async function pageProcess(dir: string, fake: FakeAdapter, delayMs = 30) {
	const slow = Object.create(fake) as FakeAdapter;
	slow.answer = async (c, choice, sig) => {
		await Bun.sleep(delayMs);
		return fake.answer!(c, choice, sig);
	};
	const layer = createWaiting({
		store: connect(dir),
		servers: () => [{ server: { name: "fake", adapter: "fake" }, adapter: slow }],
		skipThreads: () => [],
		log: () => {},
	});
	await layer.poll();
	return layer;
}

describe("a card is answered once", () => {
	test("two page processes answering the same card at the same moment: exactly one reaches the thread, the other is refused by the database", async () => {
		const dir = scratch();
		const fake = createFakeAdapter();
		fake.cards = [card];
		const [a, b] = [await pageProcess(dir, fake), await pageProcess(dir, fake)];
		const results = await Promise.all([a.answer(card.id, 0, card.sig), b.answer(card.id, 0, card.sig)]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(fake.answers).toHaveLength(1);
		expect(results.find((r) => r.status === 409)!.body.error).toContain("already sent");
	});

	test("after a restart, the same card as shown is still refused (the record is the database's, not a process's memory)", async () => {
		const dir = scratch();
		const fake = createFakeAdapter();
		fake.cards = [card];
		expect((await (await pageProcess(dir, fake, 0)).answer(card.id, 0, card.sig)).status).toBe(200);
		// A fresh process lists the card again (the backend still shows it) and is asked the same answer.
		const restarted = await pageProcess(dir, fake, 0);
		expect((await restarted.answer(card.id, 0, card.sig)).status).toBe(409);
		expect((await restarted.answer(card.id, 1, card.sig)).status).toBe(409);
		expect(fake.answers).toHaveLength(1);
	});

	test("an answer that may have been sent (the reply was lost) is never sent again, by any process, after any restart", async () => {
		const dir = scratch();
		const fake = createFakeAdapter();
		fake.cards = [card];
		fake.answerOutcome = { ok: false, kind: "unreachable", error: "could not reach T3", maybeSent: true };
		expect((await (await pageProcess(dir, fake, 0)).answer(card.id, 0, card.sig)).status).toBe(502);
		for (const _ of [1, 2])
			expect((await (await pageProcess(dir, fake, 0)).answer(card.id, 0, card.sig)).status).toBe(409);
		expect(fake.answers).toHaveLength(1);
	});

	test("an answer that was certainly not sent releases the card, so it can be answered again; a changed card is a new card", async () => {
		const dir = scratch();
		const fake = createFakeAdapter();
		fake.cards = [card];
		const page = await pageProcess(dir, fake, 0);
		fake.answerOutcome = { ok: false, kind: "stale", error: "the card changed", maybeSent: false };
		expect((await page.answer(card.id, 0, card.sig)).status).toBe(409);
		fake.answerOutcome = { ok: true, choice: "Yes" };
		expect((await (await pageProcess(dir, fake, 0)).answer(card.id, 0, card.sig)).status).toBe(200);
		expect(fake.answers).toHaveLength(2);
		// The same card id with another fingerprint is the card as it is now, a different answer.
		fake.cards = [{ ...card, sig: "sig-2" }];
		expect((await (await pageProcess(dir, fake, 0)).answer(card.id, 0, "sig-2")).status).toBe(200);
	});

	test("a reservation whose process died mid-send is retaken after five minutes, and not before", async () => {
		const { reserveCardAnswer, CARD_ANSWER_STALE_MS } = await import("./core/card-answers.ts");
		const store = connect(scratch());
		const t0 = Date.parse("2026-11-12T12:00:00Z");
		expect(reserveCardAnswer(store, { cardId: card.id, sig: "s", choice: 0, now: t0 })).toBe(true);
		expect(reserveCardAnswer(store, { cardId: card.id, sig: "s", choice: 0, now: t0 + CARD_ANSWER_STALE_MS })).toBe(
			false,
		);
		expect(reserveCardAnswer(store, { cardId: card.id, sig: "s", choice: 0, now: t0 + CARD_ANSWER_STALE_MS + 1 })).toBe(
			true,
		);
	});
});

// ---- questions -------------------------------------------------------------------------------------

const question: Question = {
	id: "Q-abcd1",
	kind: "product",
	title: "Photo first?",
	context: "ctx",
	options: [{ label: "Yes" }, { label: "No" }],
	recommended: 0,
	thread: "Mobile",
	server: "main",
	createdAt: "2026-11-09T10:00:00.000Z",
};

function pageApp(dir: string) {
	return createApp({
		capability: openCapability(),
		store: connect(dir),
		state: `${dir}/state`,
		log: () => {},
		hosts: ["127.0.0.1:3790"],
		staticDir: dir,
	});
}
/** The wakes written to the outbox: the relay sends each row, and nothing else. */
const rowsOf = (dir: string) =>
	connect(dir)
		.wakes.rows("all")
		.map((r) => r.deliveryId);
const answerReq = (app: ReturnType<typeof createApp>, choice: number) =>
	app.fetch(
		new Request("http://127.0.0.1:3790/api/items/Q-abcd1/answer", {
			method: "POST",
			headers: { host: "127.0.0.1:3790", "content-type": "application/json", "x-decision-queue": "1" },
			body: JSON.stringify({ choice }),
		}),
	);

describe("a question is answered once", () => {
	test("two page processes answering the same question at the same moment: one wake, the other refused", async () => {
		const dir = scratch();
		askQuestion(connect(dir), question);
		const [a, b] = [pageApp(dir), pageApp(dir)];
		const results = await Promise.all([answerReq(a, 0), answerReq(b, 1)]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		await Promise.all([a.idle(), b.idle()]);
		expect(rowsOf(dir)).toEqual(["answer:item:Q-abcd1"]);
		// And after a restart.
		expect((await answerReq(pageApp(dir), 0)).status).toBe(409);
		expect(rowsOf(dir)).toEqual(["answer:item:Q-abcd1"]);
		expect(getQuestion(connect(dir), "Q-abcd1")!.status).toBe("answered");
	});
});

// ---- the daemon: events and findings ----------------------------------------------------------------

/** A daemon over the shared database: a fake backend, the real engine, and the wakes the fake backend received. */
function daemon(dir: string, store: Store) {
	const conf = `${dir}/conf`;
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	writeFileSync(`${conf}/decision-rights.md`, "The Steward may merge green PRs.", { mode: 0o600 });
	const fake = createFakeAdapter();
	const engine = createEngine({
		conf,
		lock: testRelayLock(store),
		store,
		alert: noAlert,
		servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		housekeeping: false,
		log: () => {},
		timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
	});
	void engine.start();
	stoppers.push(() => engine.stop());
	return { fake, engine };
}
const ask = {
	type: "user_input_request" as const,
	requestId: "req-1",
	label: "Pick",
	questions: [{ question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }] }],
};
const emitAsk = (fake: FakeAdapter) => {
	fake.threads.set("t1", { waiting: [ask], lastMessage: "stuck" });
	fake.emit({
		kind: "needs_input",
		thread: { id: "t1", title: "Build", status: "waiting", pendingRequestId: "req-1" },
	});
};
const settle = (ms = 150) => Bun.sleep(ms);

describe("an event wakes the Steward once", () => {
	test("a second engine told of the same event at the same moment writes no second wake: the database refuses the decision", async () => {
		// A second daemon cannot run on one state directory (singleton.ts); this checks the decision itself, which the database makes once.
		const dir = scratch();
		const [a, b] = [daemon(dir, connect(dir)), daemon(dir, connect(dir))];
		// Both read the thread slowly, so both have passed the "already notified?" look before either one has written anything:
		// only the database, at the moment of the write, can tell the second that the first has already woken the Steward.
		for (const [d, ms] of [
			[a, 20],
			[b, 30],
		] as const) {
			const read = d.fake.inspect!.lastMessage;
			(d.fake.inspect as { lastMessage: unknown }).lastMessage = async (id: string) => {
				await Bun.sleep(ms);
				return read(id);
			};
		}
		emitAsk(a.fake);
		emitAsk(b.fake);
		await settle(250);
		expect(rowsOf(dir)).toHaveLength(1);
	});

	test("after a restart, the same event is not a new one", async () => {
		const dir = scratch();
		const first = daemon(dir, connect(dir));
		emitAsk(first.fake);
		await settle();
		expect(first.fake.wakes).toHaveLength(1);
		await first.engine.stop();
		const second = daemon(dir, connect(dir));
		emitAsk(second.fake);
		await settle();
		expect(second.fake.wakes).toEqual([]);
	});
});

describe("a sweep finding notifies once", () => {
	test("observed again by a fresh process, it does not notify again; observed gone and back, it does", async () => {
		const dir = scratch();
		const src = (present: boolean) => ({
			name: "check:disk",
			run: async () => (present ? [{ dedupKey: "root", text: "the root disk is full" }] : []),
		});
		const record = async (store: Store, present: boolean, now: number) =>
			recordEvaluation(store, await evaluateSource(src(present)), { now });
		expect((await record(connect(dir), true, 1)).notified).toHaveLength(1);
		expect((await record(connect(dir), true, 2)).notified).toHaveLength(0);
		expect((await record(connect(dir), false, 3)).notified).toHaveLength(0);
		expect((await record(connect(dir), true, 4)).notified).toHaveLength(1);
	});
});

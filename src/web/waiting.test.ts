/**
 * The page's waiting-card layer against the in-memory fake adapter: what is generic about mirroring and answering cards,
 * and how the page degrades when an adapter lacks `listWaiting`, `answer` or `send`.
 */

import { describe, expect, test } from "bun:test";
import { createFakeAdapter, type FakeAdapter } from "../testing/fake-adapter.ts";
import { memStore } from "../testing/store.ts";
import { useWebWaitingFixtures } from "../testing/web-waiting-fixtures.ts";
import { createWaiting, threadSender } from "./waiting.ts";

const { card, logs, pair, mirror } = useWebWaitingFixtures();

describe("listing", () => {
	test("polls each server's adapter and lists every card, passing the skip list and the link base", async () => {
		const a = createFakeAdapter(),
			b = createFakeAdapter();
		a.cards = [card()];
		b.cards = [card({ id: "C-bbbbbbbbbbbb", server: "lap", requestId: "r2" })];
		let asked: unknown;
		const orig = a.listWaiting!.bind(a);
		(a as { listWaiting: typeof a.listWaiting }).listWaiting = async (o) => {
			asked = o;
			return orig(o);
		};
		const m = mirror([pair(a), pair(b, "lap")], { links: { ws: "fake://ws/" } });
		await m.poll();
		expect(m.list().map((c) => c.requestId)).toEqual(["r1", "r2"]);
		expect(asked).toEqual({ skipThreads: ["skipped"], linkBase: "fake://ws/" });
	});

	test("a server that can't be read keeps its last cards and is listed unreachable from the first failure, until it answers again", async () => {
		const a = createFakeAdapter();
		a.cards = [card()];
		const m = mirror([pair(a)]);
		await m.poll();
		a.listError = "socket closed";
		await m.poll();
		await m.poll();
		expect(m.list()).toHaveLength(1);
		expect(m.unreachable()).toEqual([{ server: "ws", since: expect.any(String) }]);
		expect(logs.filter((l) => l.event === "mirror-error")).toHaveLength(1);
		a.listError = undefined;
		a.cards = [];
		await m.poll();
		expect(m.unreachable()).toEqual([]);
		expect(m.list()).toEqual([]);
		expect(logs.some((l) => l.event === "mirror-recovered")).toBe(true);
	});

	test("a poll still running when the next tick comes is not doubled, and a hung read can't stall it past its deadline", async () => {
		const a = createFakeAdapter();
		let calls = 0,
			release!: () => void;
		(a as { listWaiting: typeof a.listWaiting }).listWaiting = () => {
			calls++;
			return new Promise((res) => {
				release = () => res([]);
			});
		};
		const m = mirror([pair(a)]);
		const first = m.poll();
		await m.poll();
		expect(calls).toBe(1);
		release();
		await first;
		const hung = createFakeAdapter();
		(hung as { listWaiting: typeof hung.listWaiting }).listWaiting = () => new Promise(() => {});
		const ok = createFakeAdapter();
		ok.cards = [card({ id: "C-cccccccccccc", server: "ok" })];
		const m2 = mirror([pair(hung, "hung"), pair(ok, "ok")], { timeoutMs: 30 });
		await m2.poll();
		expect(m2.unreachable().map((u) => u.server)).toEqual(["hung"]);
		expect(m2.list().map((c) => c.server)).toEqual(["ok"]);
	});

	test("an adapter without listWaiting is not mirrored, and is not an error", async () => {
		const thin = createFakeAdapter({ capabilities: [] });
		const m = mirror([pair(thin)]);
		await m.poll();
		expect(m.list()).toEqual([]);
		expect(m.unreachable()).toEqual([]);
		expect(logs).toEqual([]);
	});

	test("an adapter that lists but cannot answer shows its cards read-only, and says where to answer", async () => {
		const a = createFakeAdapter({ capabilities: ["listWaiting"] });
		a.cards = [
			card(),
			card({
				id: "C-dddddddddddd",
				type: "approval",
				requestId: "r9",
				options: [{ label: "Approve once" }, { label: "Decline" }],
				command: "rm -rf build",
			}),
		];
		const m = mirror([pair(a)]);
		await m.poll();
		const [q, ap] = m.list();
		expect(q).toMatchObject({
			answerable: false,
			why: "answer it in its thread on ws",
			options: [{ label: "Yes" }, { label: "No" }],
		});
		expect(ap).toMatchObject({ answerable: false, options: [], command: "rm -rf build" });
		expect(await m.answer("C-aaaaaaaaaaaa", 0, "sig-1")).toEqual({
			status: 403,
			body: { error: "answer it in its thread on ws" },
		});
	});
});

describe("answering", () => {
	const ready = async (over: Partial<FakeAdapter> = {}) => {
		const a = createFakeAdapter();
		Object.assign(a, over);
		a.cards = [card()];
		const m = mirror([pair(a)]);
		await m.poll();
		return { a, m };
	};

	test("the core checks the card, the kind, the choice and the fingerprint before the adapter hears of it", async () => {
		const { a, m } = await ready();
		expect((await m.answer("C-zzzzzzzzzzzz", 0, "sig-1")).status).toBe(404);
		expect((await m.answer("C-aaaaaaaaaaaa", 7, "sig-1")).status).toBe(400);
		expect((await m.answer("C-aaaaaaaaaaaa", "0", "sig-1")).status).toBe(400);
		expect((await m.answer("C-aaaaaaaaaaaa", 0, "stale")).status).toBe(409);
		expect((await m.answer("C-aaaaaaaaaaaa", 0, undefined)).status).toBe(409);
		expect(a.answers).toEqual([]);
		a.cards = [
			card({ id: "C-eeeeeeeeeeee", type: "secret", answerable: false, why: "enter it in its thread", options: [] }),
		];
		await m.poll();
		expect(await m.answer("C-eeeeeeeeeeee", 0, "sig-1")).toEqual({
			status: 403,
			body: { error: "enter it in its thread" },
		});
		expect(a.answers).toEqual([]);
	});

	test("a listed card whose server has since left the server list is refused with a pointer to its thread", async () => {
		const a = createFakeAdapter();
		a.cards = [card()];
		let pairs = [pair(a)];
		const m = createWaiting({
			store: memStore(),
			servers: () => pairs,
			skipThreads: () => [],
			log: () => {},
		});
		await m.poll();
		pairs = [];
		expect(await m.answer("C-aaaaaaaaaaaa", 0, "sig-1")).toEqual({
			status: 403,
			body: { error: "answer it in its thread on ws" },
		});
		expect(a.answers).toEqual([]);
	});

	test("a good answer reaches the adapter once, drops the card, and is refused a second time", async () => {
		const { a, m } = await ready();
		expect(await m.answer("C-aaaaaaaaaaaa", 1, "sig-1")).toEqual({
			status: 200,
			body: { ok: true, choice: "answered" },
		});
		expect(a.answers).toEqual([{ card: expect.objectContaining({ id: "C-aaaaaaaaaaaa" }), choice: 1, sig: "sig-1" }]);
		expect(m.list()).toEqual([]);
	});

	test("two answers to one card arriving together send it once", async () => {
		const { a, m } = await ready();
		let release!: () => void;
		(a as { answer: typeof a.answer }).answer = async (c, choice, sig) => {
			a.answers.push({ card: c, choice, sig });
			await new Promise<void>((r) => {
				release = r;
			});
			return { ok: true, choice: "Yes" };
		};
		const first = m.answer("C-aaaaaaaaaaaa", 0, "sig-1");
		const second = await m.answer("C-aaaaaaaaaaaa", 1, "sig-1");
		expect(second.status).toBe(409);
		expect((second.body as { error: string }).error).toContain("already sent");
		release();
		expect((await first).status).toBe(200);
		expect(a.answers).toHaveLength(1);
	});

	test("each failure maps to its status, and only an answer that may have been sent stays reserved", async () => {
		const { a, m } = await ready();
		const outcome = (o: typeof a.answerOutcome) => {
			a.answerOutcome = o;
			return m.answer("C-aaaaaaaaaaaa", 0, "sig-1");
		};
		// Stale before anything was sent: 409, and the card may be answered again.
		expect(await outcome({ ok: false, kind: "stale", error: "the card changed", maybeSent: false })).toEqual({
			status: 409,
			body: { error: "the card changed" },
		});
		// Refused for rights: 403.
		expect((await outcome({ ok: false, kind: "refused", error: "no rights", maybeSent: false })).status).toBe(403);
		// The backend refused the command outright: 502, and it may be tried again.
		expect((await outcome({ ok: false, kind: "unreachable", error: "refused", maybeSent: false })).status).toBe(502);
		expect(a.answers).toHaveLength(3);
		// A reply that never came: it may have delivered, so this card as shown is never sent again from here.
		expect((await outcome({ ok: false, kind: "unreachable", error: "timed out", maybeSent: true })).status).toBe(502);
		const again = await outcome({ ok: true, choice: "Yes" });
		expect(again.status).toBe(409);
		expect(a.answers).toHaveLength(4);
	});

	test("a card that is no longer waiting is dropped from the list", async () => {
		const { a, m } = await ready();
		a.answerOutcome = {
			ok: false,
			kind: "stale",
			error: "that card was already answered or withdrawn in its thread",
			maybeSent: false,
			gone: true,
		};
		expect((await m.answer("C-aaaaaaaaaaaa", 0, "sig-1")).status).toBe(409);
		expect(m.list()).toEqual([]);
	});

	test("an adapter that throws instead of reporting is a 502, and the answer is not sent twice", async () => {
		const { a, m } = await ready();
		(a as { answer: typeof a.answer }).answer = async () => {
			throw Error("boom");
		};
		expect((await m.answer("C-aaaaaaaaaaaa", 0, "sig-1")).status).toBe(502);
		expect((await m.answer("C-aaaaaaaaaaaa", 0, "sig-1")).status).toBe(409);
	});
});

describe("sending to a thread", () => {
	test("goes through the adapter of the server it belongs to, with its seed", async () => {
		const a = createFakeAdapter();
		const send = threadSender(() => [pair(a)]);
		expect(await send("ws", "t1", "Steward, go on", "relay\0Q-abcd")).toEqual({ ok: true, detail: "sent to fake:t1" });
		expect(a.sends).toEqual([{ threadId: "t1", text: "Steward, go on", seed: "relay\0Q-abcd" }]);
	});
	test("an unknown server, or an adapter with no send, is refused so the caller falls back to the Steward", async () => {
		const thin = createFakeAdapter({ capabilities: [] });
		const send = threadSender(() => [pair(thin)]);
		expect((await send("nope", "t", "x", "s")).detail).toContain("no server named nope");
		const r = await send("ws", "t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("cannot send to threads");
	});
});

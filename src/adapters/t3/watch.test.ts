/**
 * The T3 adapter's waiting read keeps the `WaitingRead` contract: only a projection in exactly the expected shape, read over
 * a socket that stayed up, is an authoritative listing (`ok: true`). A malformed projection, no socket, a socket that drops
 * mid-read and a failed request are all `ok: false`, and a card hold read through them never closes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AdapterEnv, WaitingItem } from "../../core/adapter.ts";
import { heldOpen } from "../../core/afk.ts";
import { cardWaitOf, holdCard, reconcileCardHolds, type CardThreadRead } from "../../core/card-hold.ts";
import { questionStates } from "../../core/questions.ts";
import { memStore } from "../../testing/store.ts";
import { createT3Waiting } from "./waiting.ts";
import type { Rpc } from "./rpc.ts";
import { T3Link, waitingOf } from "./watch.ts";

const approval = { type: "approval_request", status: "waiting", requestId: "a1", label: "deploy" };
const link = (request: (tag: string, payload: unknown) => Promise<unknown>) => {
	const l = new T3Link({} as AdapterEnv, { name: "main", adapter: "t3", origin: "http://127.0.0.1:1", tokenFile: "read-token" });
	l.rpc = { request } as unknown as Rpc;
	return l;
};
/** What the engine does with an adapter read: an `ok: true` listing becomes the request IDs waiting; anything else stays as it is. */
const asCardRead = async (l: T3Link, threadId: string): Promise<CardThreadRead> => {
	const r = await l.inspector.waiting(threadId);
	return r.ok ? { ok: true, at: r.at, waiting: new Set(r.cards.map((c) => c.requestId)) } : r;
};
const card: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };

describe("T3 waiting read: a WaitingRead, authoritative only for a well-formed projection over a live socket", () => {
	test("a malformed {} projection is ok: false, never an empty listing", async () => {
		const r = await link(async () => ({})).inspector.waiting("th-1");
		expect(r.ok).toBe(false);
	});

	test("every other malformed shape is ok: false too", () => {
		for (const bad of [null, undefined, "x", 3, [], { turnItems: {} }, { turnItems: "x" }, { turnItems: [null] }, { turnItems: [3] }, { turnItems: [], runs: {} },
			{ turnItems: [{ ...approval, requestId: undefined, id: undefined }] }, { turnItems: [{ ...approval, requestId: "" }] }, { turnItems: [{ ...approval, type: undefined }] }, { turnItems: [{ ...approval, questions: "q" }] }]) {
			expect(waitingOf(bad, 1).ok).toBe(false);
		}
	});

	test("a well-formed projection is an authoritative listing taken when the read began; an empty one is ok: true with no cards", async () => {
		const before = Date.now();
		const r = await link(async () => ({ turnItems: [approval, { type: "assistant_message", status: "completed" }] })).inspector.waiting("th-1");
		expect(r).toEqual({ ok: true, cards: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }], at: expect.any(Number) });
		expect(r.ok && r.at >= before).toBe(true);
		expect(await link(async () => ({ turnItems: [] })).inspector.waiting("th-1")).toEqual({ ok: true, cards: [], at: expect.any(Number) });
	});

	test("no socket, a socket that drops during the read, and a failed request are each ok: false", async () => {
		const down = link(async () => ({ turnItems: [] }));
		down.rpc = undefined;
		expect((await down.inspector.waiting("th-1")).ok).toBe(false);
		const dropping = link(async () => { dropping.rpc = undefined; return { turnItems: [] }; });
		expect((await dropping.inspector.waiting("th-1")).ok).toBe(false);
		const failing = link(async () => { throw Error("socket hung up"); });
		expect(await failing.inspector.waiting("th-1")).toEqual({ ok: false, reason: "socket hung up" });
	});

	test("a card hold read through a malformed {} projection keeps its hold and question; a well-formed empty one closes it once", async () => {
		const store = memStore();
		holdCard(store, cardWaitOf(card, { thread: "Deploy", server: "main", threadId: "th-1" }), new Date(Date.now() - 1000));
		const open = () => ({ holds: heldOpen(store).length, questions: [...questionStates(store).values()].filter((q) => q.status === "open").length });
		const malformed = link(async () => ({}));
		const r = await reconcileCardHolds(store, (_s, t) => asCardRead(malformed, t));
		expect(r.closed).toEqual([]);
		expect(r.failed).toHaveLength(1);
		expect(open()).toEqual({ holds: 1, questions: 1 });
		const empty = link(async () => ({ turnItems: [] }));
		expect((await reconcileCardHolds(store, (_s, t) => asCardRead(empty, t))).closed).toHaveLength(1);
		expect((await reconcileCardHolds(store, (_s, t) => asCardRead(empty, t))).closed).toHaveLength(0);
		expect(open()).toEqual({ holds: 0, questions: 0 });
	});
});

describe("T3 mirror: a malformed answer is a failed read, never an empty list", () => {
	const conf = () => { const c = mkdtempSync(`${tmpdir()}/chamberlain-watchmirror-`); writeFileSync(`${c}/read-token`, "tok", { mode: 0o600 }); return c; };
	const mirror = (snapshot: unknown, projection: unknown) => createT3Waiting({
		server: { name: "main", origin: "http://x", tokenFile: "read-token" }, conf: conf(), log: () => {}, timeoutMs: 50,
		connect: (async () => ({ ws: { close() {} }, call: async (_t: string, _p: unknown, onChunk?: (v: unknown) => void) => { onChunk?.({ kind: "snapshot", snapshot }); }, request: async () => projection })) as never,
	});
	test("a snapshot with no thread list, or a thread with no id, rejects", async () => {
		await expect(mirror({}, { turnItems: [] }).listWaiting({ skipThreads: [] })).rejects.toThrow("malformed snapshot");
		await expect(mirror({ threads: [{ title: "no id" }] }, { turnItems: [] }).listWaiting({ skipThreads: [] })).rejects.toThrow("malformed snapshot");
	});
	test("a waiting thread whose projection is {} rejects", async () => {
		await expect(mirror({ threads: [{ id: "t1", pendingRuntimeRequest: { id: "a1" } }] }, {}).listWaiting({ skipThreads: [] })).rejects.toThrow("malformed projection");
	});
});

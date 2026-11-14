/**
 * The T3 adapter's waiting read keeps the `WaitingRead` contract: a projection in the expected shape, read over a socket that
 * stayed up, is `ok: true`, and lists each card item it could read (waiting, or resolved in a terminal status); a bad item is
 * skipped with a reason. Only a card's own item in a terminal status closes its hold: absence from the bounded history window,
 * a non-terminal or unknown status, a malformed item, no socket and a failed request close nothing. `archivedAt: {}` is not archived.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AdapterEnv, WaitingItem } from "../../core/adapter.ts";
import { heldOpen } from "../../core/afk.ts";
import { cardWaitOf, holdCard } from "../../core/card-hold.ts";
import { type CardThreadRead, reconcileCardHolds } from "../../core/card-reconcile.ts";
import { questionStates } from "../../core/questions.ts";
import { memStore } from "../../testing/store.ts";
import { OPEN_CARD_STATUSES, readCards, TERMINAL_CARD_STATUSES } from "./projection.ts";
import type { Rpc } from "./rpc.ts";
import { toState } from "./state.ts";
import { createT3Waiting } from "./waiting.ts";
import { T3Link, waitingOf } from "./watch.ts";

const approval = { type: "approval_request", status: "waiting", requestId: "a1", label: "deploy" };
const link = (request: (tag: string, payload: unknown) => Promise<unknown>) => {
	const l = new T3Link({} as AdapterEnv, {
		name: "main",
		adapter: "t3",
		origin: "http://127.0.0.1:1",
		tokenFile: "read-token",
	});
	l.rpc = { request } as unknown as Rpc;
	return l;
};
/** What the engine does with an adapter read: an `ok: true` listing becomes the request IDs waiting; anything else stays as it is. */
const asCardRead = async (l: T3Link, threadId: string): Promise<CardThreadRead> => {
	const r = await l.inspector.waiting(threadId);
	return r.ok
		? { ok: true, waiting: new Set(r.cards.map((c) => c.requestId)), resolved: new Set(r.resolved ?? []) }
		: r;
};
const card: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };

describe("readCards: per card item, never all or nothing; only a terminal status is evidence", () => {
	const window75 = Array.from({ length: 75 }, (_, n) => ({
		type: "assistant_message",
		status: "completed",
		text: `m${n}`,
	}));
	test("TERMINAL_CARD_STATUSES is exactly T3's resolved statuses; OPEN_CARD_STATUSES the rest of its schema", () => {
		expect([...TERMINAL_CARD_STATUSES].sort()).toEqual(["cancelled", "completed", "failed", "interrupted"]);
		expect([...OPEN_CARD_STATUSES].sort()).toEqual(["idle", "pending", "running", "waiting"]);
	});
	test("each terminal status, on every card kind, lists the card as resolved", () => {
		for (const status of TERMINAL_CARD_STATUSES)
			for (const type of ["approval_request", "secret_request", "user_input_request", "link_request"]) {
				expect([status, type, readCards([{ ...approval, type, status }], "th-1")]).toEqual([
					status,
					type,
					{ ok: true, cards: [], resolved: ["a1"], ignored: [] },
				]);
			}
	});
	test("a type that merely contains 'link' is not a card and can never resolve one", () => {
		for (const type of ["hyperlink", "link_preview", "Link", "unlinked_request_note", "linkrequest"]) {
			expect([type, readCards([{ type, id: "a1", threadId: "th-1", status: "completed" }], "th-1").resolved]).toEqual([
				type,
				[],
			]);
		}
		for (const type of ["link_request", "machine_link_request", "environment_link_request"]) {
			expect([type, readCards([{ type, id: "a1", threadId: "th-1", status: "completed" }], "th-1").resolved]).toEqual([
				type,
				["a1"],
			]);
		}
	});
	test("a non-terminal status is not resolved: waiting lists the card, the others list it nowhere", () => {
		expect(readCards([approval], "th-1")).toEqual({
			ok: true,
			cards: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }],
			resolved: [],
			ignored: [],
		});
		for (const status of ["idle", "pending", "running"])
			expect(readCards([{ ...approval, status }], "th-1")).toEqual({ ok: true, cards: [], resolved: [], ignored: [] });
	});
	test("a listing with no status, and every unknown or malformed status or request id, is ignored with a reason, never resolved", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ status: undefined }, "has no status"],
			[{ status: 1 }, "has no status"],
			[{ status: "" }, "has no status"],
			[{ status: "expired" }, "unknown status"],
			[{ status: "resolved" }, "unknown status"],
			[{ status: "Completed" }, "unknown status"],
			[{ requestId: undefined }, "no valid request id"],
			[{ requestId: "" }, "no valid request id"],
			[{ requestId: "  " }, "no valid request id"],
			[{ requestId: 7, status: "completed" }, "no valid request id"],
			[{ requestId: undefined, id: "", status: "completed" }, "no valid request id"],
		];
		for (const [over, why] of cases) {
			const item = { ...approval, ...over };
			for (const k of Object.keys(over)) if (over[k] === undefined) delete (item as Record<string, unknown>)[k];
			const r = readCards([item, { type: "secret_request", status: "cancelled", requestId: "s1" }], "th-1");
			expect([over, r.resolved, r.ignored[0]]).toEqual([over, ["s1"], expect.stringContaining(why)]);
		}
		expect(readCards([{ type: "approval_request", requestId: "a1" }], "th-1")).toEqual({
			ok: true,
			cards: [],
			resolved: [],
			ignored: ["card item 0 (approval_request) a1 has no status"],
		});
	});
	test("a terminal item is not resolved while another item of the same card is still going, unknown or has no status; it still shows as waiting", () => {
		for (const other of [
			approval,
			{ ...approval, status: "pending" },
			{ ...approval, status: "expired" },
			{ type: "approval_request", requestId: "a1" },
		]) {
			const r = readCards([{ ...approval, status: "completed" }, other], "th-1");
			expect([other, r.resolved, r.ignored]).toEqual([
				other,
				[],
				expect.arrayContaining(["card a1 has a terminal item and one still going or unreadable: not resolved"]),
			]);
		}
		expect(
			readCards(
				[
					{ ...approval, status: "completed" },
					{ ...approval, status: "cancelled" },
				],
				"th-1",
			).resolved,
		).toEqual(["a1"]);
	});
	test("the key is requestId ?? id: an approval by its requestId, a secret or user-input item by its id alone", () => {
		expect(
			readCards([{ type: "approval_request", requestId: "a1", id: "item-9", status: "completed" }], "th-1").resolved,
		).toEqual(["a1"]);
		expect(readCards([{ type: "secret_request", id: "s1", status: "cancelled" }], "th-1").resolved).toEqual(["s1"]);
		expect(readCards([{ type: "user_input_request", id: "u1", status: "completed" }], "th-1").resolved).toEqual(["u1"]);
		expect(
			readCards([{ type: "secret_request", requestId: null, id: "s2", status: "completed" }], "th-1").resolved,
		).toEqual(["s2"]);
		expect(
			readCards([{ type: "secret_request", id: "s3", status: "waiting" }], "th-1").cards.map((c) => c.requestId),
		).toEqual(["s3"]);
	});
	test("an item that names another thread is not this thread's: never resolved here; one naming this thread, or none, is", () => {
		expect(readCards([{ ...approval, status: "completed", threadId: "th-2" }], "th-1").resolved).toEqual([]);
		expect(readCards([{ ...approval, status: "completed", threadId: "th-1" }], "th-1").resolved).toEqual(["a1"]);
		expect(readCards([{ ...approval, status: "completed" }], "th-1").resolved).toEqual(["a1"]);
	});
	test("a request ID that is a prefix of another is its own card", () => {
		expect(readCards([{ ...approval, requestId: "req-10", status: "completed" }], "th-1").resolved).toEqual(["req-10"]);
	});
	test("a bounded window that leaves the card out says nothing of it", () => {
		expect(readCards(window75, "th-1")).toEqual({ ok: true, cards: [], resolved: [], ignored: [] });
	});
	test("items that are not cards, or have no type, are passed over; a link card may carry its ID in `id`", () => {
		expect(
			readCards([{ type: "tool_call" }, { status: "completed", requestId: "a1" }, null, 3], "th-1").resolved,
		).toEqual([]);
		expect(readCards([{ type: "machine_link_request", status: "waiting", id: "L1" }], "th-1").cards).toEqual([
			{ type: "link_request", requestId: "L1", label: "", questions: [] },
		]);
	});
});

describe("T3 lastAssistant: the last finished assistant message with its id and time", () => {
	const msg = (itemId: string, text: string, updatedAt: string, status = "completed") => ({
		type: "assistant_message",
		itemId,
		status,
		text,
		updatedAt,
	});
	test("it is the newest completed assistant message, not a later one still streaming or a user message", async () => {
		const l = link(async () => ({
			turnItems: [
				msg("a1", "first", "2026-11-14T01:00:00.000Z"),
				msg("a2", "second", "2026-11-14T02:00:00.000Z"),
				msg("a3", "partial", "2026-11-14T03:00:00.000Z", "streaming"),
				{ type: "user_message", itemId: "u1", text: "go", updatedAt: "2026-11-14T04:00:00.000Z" },
			],
		}));
		expect(await l.inspector.lastAssistant!("th-1")).toEqual({
			id: "a2",
			text: "second",
			at: "2026-11-14T02:00:00.000Z",
		});
	});
	test("previous: the last non-empty user message before it, human when T3 says createdBy user, else agent", async () => {
		const user = (itemId: string, text: string, createdBy?: string) => ({
			type: "user_message",
			itemId,
			text,
			updatedAt: "2026-11-14T00:00:00.000Z",
			...(createdBy ? { createdBy } : {}),
		});
		const read = async (turnItems: unknown[]) =>
			(await link(async () => ({ turnItems })).inspector.lastAssistant!("th-1"))?.previous;
		expect(
			await read([
				user("u1", "older", "user"),
				user("u2", "which tabs?", "user"),
				msg("a1", "half", "2026-11-14T02:00:00.000Z"),
			]),
		).toEqual({ by: "human", text: "which tabs?" });
		expect(await read([user("u1", "continue", "orchestrator"), msg("a1", "ok", "2026-11-14T02:00:00.000Z")])).toEqual({
			by: "agent",
			text: "continue",
		});
		expect(await read([user("u1", "no author"), msg("a1", "ok", "2026-11-14T02:00:00.000Z")])).toEqual({
			by: "agent",
			text: "no author",
		});
		// A user message AFTER the last finished answer is not the one it answered; a blank one is passed over.
		expect(
			await read([
				user("u1", "the question", "user"),
				user("u2", "   ", "user"),
				msg("a1", "answer", "2026-11-14T02:00:00.000Z"),
				user("u3", "later", "user"),
			]),
		).toEqual({ by: "human", text: "the question" });
		expect(await read([msg("a1", "alone", "2026-11-14T02:00:00.000Z")])).toBeUndefined();
	});
	test("no assistant message, no time, or no socket reads as nothing, and a malformed projection throws", async () => {
		expect(await link(async () => ({ turnItems: [] })).inspector.lastAssistant!("th-1")).toBeUndefined();
		expect(
			await link(async () => ({
				turnItems: [{ type: "assistant_message", itemId: "a", status: "completed", text: "x" }],
			})).inspector.lastAssistant!("th-1"),
		).toBeUndefined();
		const down = link(async () => ({ turnItems: [] }));
		down.rpc = undefined;
		expect(await down.inspector.lastAssistant!("th-1")).toBeUndefined();
		await expect(link(async () => ({})).inspector.lastAssistant!("th-1")).rejects.toThrow("malformed projection");
	});
});

describe("T3 waiting read: ok: true only for a projection in the expected shape over a live socket", () => {
	test("a malformed {} projection, and every other malformed projection shape, is ok: false", async () => {
		expect((await link(async () => ({})).inspector.waiting("th-1")).ok).toBe(false);
		for (const bad of [
			null,
			undefined,
			"x",
			3,
			[],
			{ turnItems: {} },
			{ turnItems: "x" },
			{ turnItems: [null] },
			{ turnItems: [3] },
			{ turnItems: [], runs: {} },
		]) {
			expect(waitingOf(bad, "th-1").ok).toBe(false);
		}
	});

	test("a projection's cards: those waiting, those resolved, and why any were skipped", async () => {
		const r = await link(async () => ({
			turnItems: [
				approval,
				{ type: "secret_request", status: "cancelled", requestId: "s1" },
				{ type: "assistant_message", status: "completed" },
			],
		})).inspector.waiting("th-1");
		expect(r).toEqual({
			ok: true,
			cards: [{ type: "approval_request", requestId: "a1", label: "deploy", questions: [] }],
			resolved: ["s1"],
			ignored: [],
		});
		expect(await link(async () => ({ turnItems: [] })).inspector.waiting("th-1")).toEqual({
			ok: true,
			cards: [],
			resolved: [],
			ignored: [],
		});
	});

	test("no socket, a socket that drops during the read, and a failed request are each ok: false", async () => {
		const down = link(async () => ({ turnItems: [] }));
		down.rpc = undefined;
		expect((await down.inspector.waiting("th-1")).ok).toBe(false);
		const dropping = link(async () => {
			dropping.rpc = undefined;
			return { turnItems: [{ ...approval, status: "completed" }] };
		});
		expect((await dropping.inspector.waiting("th-1")).ok).toBe(false);
		const failing = link(async () => {
			throw Error("socket hung up");
		});
		expect(await failing.inspector.waiting("th-1")).toEqual({ ok: false, reason: "socket hung up" });
	});

	test("through the real adapter read: {}, the missing-status listing, a 75-item window without the card and a non-terminal status keep the hold; each terminal status closes it once", async () => {
		const window75 = Array.from({ length: 75 }, (_, n) => ({
			type: "assistant_message",
			status: "completed",
			text: `m${n}`,
		}));
		for (const [status, kind] of [...TERMINAL_CARD_STATUSES].flatMap(
			(st) =>
				[
					[st, "approval"],
					[st, "secret"],
				] as const,
		)) {
			const store = memStore();
			const theCard: WaitingItem =
				kind === "approval" ? card : { type: "secret_request", requestId: "a1", label: "KEY", questions: [] };
			holdCard(store, cardWaitOf(theCard, { thread: "Deploy", server: "main", threadId: "th-1" }));
			const open = () => ({
				holds: heldOpen(store).length,
				questions: [...questionStates(store).values()].filter((q) => q.status === "open").length,
			});
			for (const bad of [
				{},
				{ turnItems: [{ type: "approval_request", requestId: "a1" }] },
				{ turnItems: window75 },
				{ turnItems: [{ ...approval, status: "pending" }] },
				{ turnItems: [{ ...approval, status: "expired" }] },
			]) {
				expect(
					(
						await reconcileCardHolds(store, (_s, t) =>
							asCardRead(
								link(async () => bad),
								t,
							),
						)
					).closed,
				).toEqual([]);
				expect(open()).toEqual({ holds: 1, questions: 1 });
			}
			// T3's approval item carries requestId; its secret item carries only id.
			const item =
				kind === "approval" ? { ...approval, status } : { type: "secret_request", id: "a1", threadId: "th-1", status };
			const done = link(async () => ({ turnItems: [...window75, item] }));
			expect([status, kind, (await reconcileCardHolds(store, (_s, t) => asCardRead(done, t))).closed]).toEqual([
				status,
				kind,
				[{ server: "main", threadId: "th-1", requestId: "a1" }],
			]);
			expect((await reconcileCardHolds(store, (_s, t) => asCardRead(done, t))).closed).toEqual([]);
			expect(open()).toEqual({ holds: 0, questions: 0 });
		}
	});
});

describe("T3 thread state and snapshot: nothing here can close a card hold", () => {
	test("archivedAt: {} (or any value that is not a timestamp) is not archived; a real timestamp is", () => {
		for (const v of [{}, true, 1, "not a date", [], null, undefined])
			expect([v, toState({ id: "t", archivedAt: v }).archived]).toEqual([v, false]);
		expect(toState({ id: "t", archivedAt: "2026-11-13T10:00:00Z" }).archived).toBe(true);
		expect(toState({ id: "t", settledAt: {} }).settled).toBe(false);
	});
});

describe("T3 mirror: a malformed answer is a failed read, never an empty list", () => {
	const conf = () => {
		const c = mkdtempSync(`${tmpdir()}/chamberlain-watchmirror-`);
		writeFileSync(`${c}/read-token`, "tok", { mode: 0o600 });
		return c;
	};
	const mirror = (snapshot: unknown, projection: unknown) =>
		createT3Waiting({
			server: { name: "main", origin: "http://x", tokenFile: "read-token" },
			conf: conf(),
			log: () => {},
			timeoutMs: 50,
			connect: (async () => ({
				ws: { close() {} },
				call: async (_t: string, _p: unknown, onChunk?: (v: unknown) => void) => {
					onChunk?.({ kind: "snapshot", snapshot });
				},
				request: async () => projection,
			})) as never,
		});
	test("a snapshot with no thread list, or a thread with no id, rejects", async () => {
		await expect(mirror({}, { turnItems: [] }).listWaiting({ skipThreads: [] })).rejects.toThrow("malformed snapshot");
		await expect(
			mirror({ threads: [{ title: "no id" }] }, { turnItems: [] }).listWaiting({ skipThreads: [] }),
		).rejects.toThrow("malformed snapshot");
	});
	test("a waiting thread whose projection is {} rejects", async () => {
		await expect(
			mirror({ threads: [{ id: "t1", pendingRuntimeRequest: { id: "a1" } }] }, {}).listWaiting({ skipThreads: [] }),
		).rejects.toThrow("malformed projection");
	});
});

/** watch, continued: see watch.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingItem } from "../../core/adapter/adapter-waiting.ts";
import { cardWaitOf, holdCard } from "../../core/items/card-hold.ts";
import { reconcileCardHolds } from "../../core/items/card-reconcile.ts";
import { questionStates } from "../../core/items/questions.ts";
import { heldOpen } from "../../core/ops/afk-held.ts";
import { approval, asCardRead, card, link } from "../../testing/adapters-t3-watch-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { TERMINAL_CARD_STATUSES } from "./projection.ts";
import { toState } from "./state.ts";
import { createT3Waiting } from "./waiting.ts";
import { waitingOf } from "./watch.ts";

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

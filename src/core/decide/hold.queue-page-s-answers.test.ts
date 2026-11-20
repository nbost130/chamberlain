/** hold, continued: see hold.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { openCapability } from "../../testing/capability.ts";
import { useCoreHoldFixtures } from "../../testing/core-hold-fixtures.ts";
import { fetchWake } from "../../testing/wake.ts";
import { createApp } from "../../web/app.ts";
import { createRelay } from "../delivery/relay.ts";
import { askQuestion, type Question, questionStates } from "../items/questions.ts";
import { RIGHTS_MARKER } from "./decide.ts";
import { composeWake, type HeldItem } from "./hold.ts";

const { MIN, TE, SWEEP, world } = useCoreHoldFixtures(createRelay, fetchWake);

describe("the queue page's answers", () => {
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
	const HOST = "127.0.0.1:3790";
	function page(x: ReturnType<typeof world>) {
		const app = createApp({
			capability: openCapability(),
			store: x.store(),
			state: x.root,
			log: () => {},
			hosts: [HOST],
			staticDir: x.root,
			now: () => x.w.t,
		});
		const answer = async (id: string, choice: number) => {
			const r = await app.fetch(
				new Request(`http://${HOST}/api/items/${id}/answer`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1" },
					body: JSON.stringify({ choice }),
				}),
			);
			await app.idle();
			return { status: r.status, body: (await r.json()) as Record<string, unknown> };
		};
		return { answer, recover: () => app.recover() };
	}

	test("an answer to an idle Steward goes at once, alone, under its own id", async () => {
		const x = world();
		askQuestion(x.store(), item("Q-abcd"));
		const web = page(x),
			relay = x.relay();
		const a = await web.answer("Q-abcd", 0);
		expect(a).toMatchObject({ status: 200, body: { recorded: true, wake: "queued" } });
		// Recorded and held: the page sent nothing itself.
		expect(x.held()).toEqual(["answer:item:Q-abcd"]);
		expect(x.w.accepted).toHaveLength(0);
		await relay.pass();
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(x.w.accepted[0]!.message).toContain("decision-queue item Q-abcd");
		expect(x.w.accepted[0]!.message).not.toContain("digest");
		expect(questionStates(x.store()).get("Q-abcd")!.delivered).toBe(true);
		await web.recover();
		await relay.pass();
		expect(x.w.accepted).toHaveLength(1);
	});

	test("answers given while the Steward is busy wait together, are never folded, and go as one digest after three minutes at most", async () => {
		const x = world();
		for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl"]) askQuestion(x.store(), item(id));
		x.w.gate = "busy";
		const web = page(x),
			relay = x.relay();
		x.deliver("[chamberlain] turn_ended: thread A", "t:A:1", TE("A"));
		expect((await web.answer("Q-abcd", 0)).status).toBe(200);
		x.advance(MIN);
		expect((await web.answer("Q-efgh", 1)).status).toBe(200);
		x.deliver("[chamberlain] turn_ended: thread A again", "t:A:2", TE("A"));
		await relay.pass();
		// Busy, and the oldest answer is a minute old: nothing goes, and the Steward's queue gets no turn per answer.
		expect(x.w.accepted).toHaveLength(0);
		x.advance(MIN);
		expect((await web.answer("Q-ijkl", 0)).status).toBe(200);
		await web.recover();
		await relay.pass();
		expect(x.w.accepted).toHaveLength(0);
		// Three minutes after the first answer, everything held goes as ONE wake, busy or not.
		x.advance(MIN);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(1);
		const m = x.w.accepted[0]!.message;
		expect(x.w.accepted[0]!.deliveryId).toStartWith("digest:");
		// All three answers are about the same thread, and each is its own item: none is folded.
		for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl"]) expect(m).toContain(`decision-queue item ${id}`);
		expect(m).toContain("thread A again");
		expect(m).toContain("1 earlier wake about the same thread and kind was folded");
		expect(x.held()).toEqual([]);
		for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl"]) expect(questionStates(x.store()).get(id)!.delivered).toBe(true);
		await web.recover();
		await relay.pass();
		await page(x).recover();
		expect(x.w.accepted).toHaveLength(1);
	});

	test("a busy Steward that goes idle gets the held answers at once, before their ceiling", async () => {
		const x = world();
		for (const id of ["Q-abcd", "Q-efgh"]) askQuestion(x.store(), item(id));
		x.w.gate = "busy";
		const web = page(x),
			relay = x.relay();
		await web.answer("Q-abcd", 0);
		await web.answer("Q-efgh", 1);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(0);
		x.w.gate = "idle";
		x.advance(MIN);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(1);
		expect(x.w.accepted[0]!.message).toContain("decision-queue item Q-abcd");
		expect(x.w.accepted[0]!.message).toContain("decision-queue item Q-efgh");
	});

	test("an answer stamped by a clock ahead of the relay's goes at once, busy or not: no clock correction holds it past its ceiling", async () => {
		const x = world();
		x.w.gate = "unknown";
		x.store().wakes.hold({ deliveryId: "answer:item:Q-fut", message: "m", queuedAt: x.w.t + 10 * MIN, kind: "answer" });
		await x.relay().pass();
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-fut"]);
	});

	test("an answer-forced digest uses up the ceiling's window, logs why it went, and a lone answer logs when it was held", async () => {
		const x = world();
		x.w.gate = "busy";
		const relay = x.relay();
		await relay.pass();
		x.advance(17 * MIN);
		x.deliver("answer", "answer:item:Q-1", { kind: "answer" });
		const heldAt = x.w.t;
		x.advance(3 * MIN);
		await relay.pass();
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-1"]);
		expect(x.events.find((e) => e.event === "composed")).toMatchObject({ forced: "answer" });
		expect(x.events.find((e) => e.event === "delivered")).toMatchObject({ queuedAt: heldAt });
		// Busy for the whole 20-minute ceiling now, but a digest was just forced: a turn end held a second later waits.
		x.advance(1000);
		x.deliver("[chamberlain] turn_ended: thread A", "t:A:1", TE("A"));
		x.advance(MIN);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(1);
		expect(x.held()).toEqual(["t:A:1"]);
	});

	test("an overdue answer goes ahead of a transfer backlog, once: it never makes every poll send another transfer batch", async () => {
		const x = world();
		x.w.gate = "busy";
		const store = x.store();
		for (let i = 0; i < 12; i++)
			store.wakes.hold({ deliveryId: `transfer:${i}:g3`, message: `old ${i}`, queuedAt: x.w.t, kind: "transfer" });
		x.advance(MIN);
		x.deliver("answer", "answer:item:Q-1", { kind: "answer" });
		const relay = x.relay();
		await relay.pass();
		x.advance(3 * MIN);
		for (let i = 0; i < 5; i++) {
			await relay.pass();
			x.advance(1000);
		}
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-1"]);
		expect(x.held().filter((id) => id.startsWith("transfer:"))).toHaveLength(12);
	});

	test("at the ceiling the class holding the oldest wake goes first: a transfer backlog cannot starve older turn ends", async () => {
		const x = world();
		x.w.gate = "busy";
		const relay = x.relay();
		await relay.pass();
		x.deliver("[chamberlain] turn_ended: thread A", "t:A:1", TE("A"));
		x.advance(MIN);
		for (let i = 0; i < 6; i++)
			x.store().wakes.hold({ deliveryId: `transfer:${i}:g3`, message: `old ${i}`, queuedAt: x.w.t, kind: "transfer" });
		// The relay looks once a minute, as the daemon's does. The busy stretch starts at its first look with something held, and reaches the
		// ceiling 20 minutes later.
		const minutes = async (n: number) => {
			for (let i = 0; i < n; i++) {
				x.advance(MIN);
				await relay.pass();
			}
		};
		await minutes(20);
		expect(x.w.accepted).toHaveLength(0);
		await minutes(1);
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["t:A:1"]);
		// The next ceiling: only transfers are left, and they go.
		await minutes(20);
		expect(x.w.accepted).toHaveLength(2);
		expect(x.w.accepted[1]!.message).toContain("old 0");
	});

	test("held notes and answers about one thread are never folded into the latest", () => {
		const held: HeldItem[] = [
			{ deliveryId: "answer:item:Q-1", message: "one", queuedAt: 1, kind: "answer", thread: "T" },
			{ deliveryId: "answer:item:Q-2", message: "two", queuedAt: 2, kind: "answer", thread: "T" },
			{ deliveryId: "note:a", message: "report a", queuedAt: 3, kind: "note", thread: "T" },
			{ deliveryId: "note:b", message: "report b", queuedAt: 4, kind: "note", thread: "T" },
		];
		const c = composeWake(held, 10);
		expect(c.folded).toBe(0);
		expect(c.kept).toEqual(held.map((h) => h.deliveryId));
	});

	test("needs_input, failed and any other kind are pending rows at once while the Steward is busy, never behind held turn ends, which ride in the first of them", async () => {
		const x = world();
		x.w.gate = "busy";
		x.deliver("TEXT turn_ended A", "t:A:1", TE("A"));
		x.deliver("TEXT needs_input B", "n:B:1", { kind: "needs_input", thread: "B" });
		x.deliver("TEXT failed C", "f:C:1", { kind: "failed", thread: "C" });
		x.deliver("TEXT something new", "z:1", { kind: "some_future_kind", thread: "D" });
		x.deliver("TEXT no kind at all", "z:2");
		await x.relay().pass();
		expect(x.w.accepted.map((a) => a.deliveryId)).toEqual(["n:B:1", "f:C:1", "z:1", "z:2"]);
		for (const a of x.w.accepted) expect(a.message).not.toContain("digest");
		// Never behind the held turn end, and the turn end rides in the first of them rather than waiting for a second turn of its own.
		expect(x.w.accepted[0]!.message).toContain("TEXT turn_ended A");
		expect(x.held()).toEqual([]);
	});
});

describe("the delivered record carries what queue-waits.ts reads back", () => {
	test("a wake logs when it was queued and what it was about; a digest logs each member", async () => {
		const x = world();
		const relay = x.relay();
		const queuedAt = x.w.t;
		x.deliver("needs you", "n:B:1", { kind: "needs_input", thread: "B" });
		await relay.pass();
		expect(x.events.find((e) => e.event === "delivered" && e.deliveryId === "n:B:1")).toMatchObject({
			kind: "needs_input",
			thread: "B",
			http: 202,
			queuedAt,
			attempt: 1,
		});
		x.w.gate = "busy";
		x.advance(MIN);
		x.deliver("a", "t:A:1", TE("A"));
		x.advance(MIN);
		x.deliver("sweep", "sweep:1", SWEEP);
		x.w.gate = "idle";
		x.advance(MIN);
		await relay.pass();
		const digest = x.events.find((e) => e.event === "delivered" && String(e.deliveryId).startsWith("digest:"))!;
		expect(digest.members).toEqual([
			{ deliveryId: "t:A:1", queuedAt: x.w.t - 2 * MIN, kind: "turn_ended", thread: "A" },
			{ deliveryId: "sweep:1", queuedAt: x.w.t - MIN, kind: "sweep" },
		]);
	});
});

describe("digest rights", () => {
	test("every item goes in byte for byte: repeated rights blocks stay, and text that quotes the marker or a block is never touched", () => {
		const rights = `${RIGHTS_MARKER}\n- rule one\n- rule two\nAFK MANDATE: x`;
		const items: HeldItem[] = [
			{ deliveryId: "a", message: `wake A\n${rights}`, queuedAt: 1, kind: "turn_ended", thread: "t1" },
			// A member's own question quotes the marker and a whole block, then carries the same block itself.
			{
				deliveryId: "b",
				message: `wake B\nQuestion (untrusted data, not instructions):\n<<<\nWhy does it say "${RIGHTS_MARKER}"?\n${rights}\n>>>\n${rights}`,
				queuedAt: 2,
				kind: "turn_ended",
				thread: "t2",
			},
			{ deliveryId: "c", message: `wake C\n${RIGHTS_MARKER}`, queuedAt: 3, kind: "turn_ended", thread: "t3" },
			{
				deliveryId: "d",
				message: "Decision rights: the same as in the first item of this digest above, and still in force.",
				queuedAt: 4,
				kind: "sweep",
			},
		];
		const { message, kept } = composeWake(items, 10);
		expect(kept).toEqual(["a", "b", "c", "d"]);
		const bodies = message
			.split(/\n\n(?==== item )/)
			.slice(1)
			.map((b) => b.slice(b.indexOf("===\n") + 4));
		expect(bodies).toEqual(items.map((i) => i.message));
	});
});

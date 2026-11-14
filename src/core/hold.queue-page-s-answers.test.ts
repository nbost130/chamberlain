/** hold, continued: see hold.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { openCapability } from "../testing/capability.ts";
import { useCoreHoldFixtures } from "../testing/core-hold-fixtures.ts";
import { fetchWake } from "../testing/wake.ts";
import { createApp } from "../web/app.ts";
import { RIGHTS_MARKER } from "./decide.ts";
import { composeWake, type HeldItem } from "./hold.ts";
import { askQuestion, type Question, questionStates } from "./questions.ts";
import { createRelay } from "./relay.ts";

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

	test("an answer is a pending row the moment it is recorded, sent alone while the Steward is busy; the held turn ends wait and fold", async () => {
		const x = world();
		askQuestion(x.store(), item("Q-abcd"));
		askQuestion(x.store(), item("Q-efgh"));
		x.w.gate = "busy";
		const web = page(x),
			relay = x.relay();
		x.deliver("[chamberlain] turn_ended: thread A", "t:A:1", TE("A"));
		const a = await web.answer("Q-abcd", 0);
		expect(a).toMatchObject({ status: 200, body: { recorded: true, wake: "queued" } });
		// Recorded with its row: the page sent nothing itself.
		expect(x.store().wakes.find("answer:item:Q-abcd")).toMatchObject({ status: "pending", attempts: 0 });
		expect(x.w.accepted).toHaveLength(0);
		await relay.pass();
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(x.w.accepted[0]!.message).toContain("decision-queue item Q-abcd");
		expect(questionStates(x.store()).get("Q-abcd")!.delivered).toBe(true);
		expect((await web.answer("Q-efgh", 1)).status).toBe(200);
		x.deliver("[chamberlain] turn_ended: thread A again", "t:A:2", TE("A"));
		await relay.pass();
		expect(x.w.accepted.map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd", "answer:item:Q-efgh"]);
		expect(x.held()).toEqual(["t:A:1", "t:A:2"]);
		await web.recover();
		await web.recover();
		await relay.pass();
		expect(x.w.accepted).toHaveLength(2);
		x.w.gate = "idle";
		x.advance(MIN);
		await relay.pass();
		expect(x.w.accepted).toHaveLength(3);
		const m = x.w.accepted[2]!.message;
		expect(m).toContain("thread A again");
		expect(m).not.toContain("decision-queue item");
		expect(m).toContain("1 earlier wake about the same thread and kind was folded");
		await web.recover();
		await relay.pass();
		await page(x).recover();
		expect(x.w.accepted).toHaveLength(3);
	});

	test("needs_input, failed and any other kind are pending rows at once while the Steward is busy, never behind held turn ends", async () => {
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
		expect(x.held()).toEqual(["t:A:1"]);
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

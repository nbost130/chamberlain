/** A card parked before the principal went away follows away routing when it is released, exactly as a fresh card does (`routeNeedsInput`). */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { heldOpen } from "../ops/afk-held.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, question } = useCoreEngineFixtures(createEngine);
const MIN = 60_000;
const ON = { enabled: true, windowMs: 5 * MIN };
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));
const approval = { type: "approval_request" as const, requestId: "req-a", label: "Run the migration", questions: [] };

function park(r: ReturnType<typeof rig>, id: string, card: typeof approval | typeof question) {
	r.fake.threads.set(id, { waiting: [card], principalAt: r.clock.t - MIN });
	r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: card.requestId }) });
}

describe("a parked card released after the principal went away", () => {
	test("an operator-only card is held for their return and never handed to the Steward; a card the Steward can answer wakes it", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		park(r, "t-approval", approval);
		park(r, "t-question", { ...question, requestId: "req-q" });
		await r.until("both parked", () => r.store.wakes.parked().length === 2);
		r.store.away.enter({ enteredAt: new Date(r.clock.t).toISOString(), words: "heading out" });
		await r.engine.tick();
		await r.until("the question's wake", () => posts(r).length === 1);
		await r.until("the approval held", () => r.events.some((e) => e.event === "held-by-daemon"));
		expect(posts(r)[0]!.message).toContain('thread "Thread t-question"');
		expect(posts(r).some((w) => w.message.includes("Thread t-approval"))).toBe(false);
		expect(r.store.wakes.parked()).toEqual([]);
		expect(heldOpen(r.store).some((h) => h.threadId === "t-approval" || h.card?.threadId === "t-approval")).toBe(true);
		expect(r.events.find((e) => e.event === "active-hold-dropped")).toMatchObject({ reason: "held-for-return" });
	});

	test("not away, an operator-only card released at its time wakes the Steward as it does today", async () => {
		const r = rig({ steward: "steward-1", activeHold: ON });
		park(r, "t-approval", approval);
		await r.until("parked", () => r.store.wakes.parked().length === 1);
		r.clock.t += 5 * MIN;
		await r.engine.tick();
		await r.until("the wake", () => posts(r).length === 1);
		expect(heldOpen(r.store)).toEqual([]);
	});
});

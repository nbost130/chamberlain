/** A held turn-end report goes stale when its thread starts a new turn: the engine marks it, and the relay gives it up. */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));

describe("held turn-end reports and their thread's next turn", () => {
	const ended = (r: ReturnType<typeof rig>, id: string) => {
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: `s-${id}` }], state: "complete", byMachine: false },
			lastMessage: `${id} finished the work.`,
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
	};

	test("a report whose thread started a new turn is given up for good; the other goes, saying its thread has not moved", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t2");
		ended(r, "t3");
		ended(r, "t4");
		await r.until("three held", () => r.held().length === 3);
		const t2 = r.held().find((h) => h.deliveryId.startsWith("t2:"))!.deliveryId;
		// t2 starts its next turn while the Steward is busy: its held report is now stale.
		r.fake.emit({ kind: "state", thread: thread("t2", "running") });
		await r.until("t2 marked", () => r.store.wakes.superseded().some((s) => s.deliveryId === t2));
		expect(r.store.wakes.superseded()).toEqual([{ deliveryId: t2, at: expect.any(Number), why: "new-turn" }]);
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.until("the digest", () => posts(r).some((w) => w.deliveryId.startsWith("digest:")));
		const digest = posts(r).find((w) => w.deliveryId.startsWith("digest:"))!;
		expect(digest.message).toContain("digest: 2 wakes were held");
		expect(digest.message).toContain('thread "Thread t3"');
		expect(digest.message).toContain('thread "Thread t4"');
		expect(digest.message).not.toContain('thread "Thread t2"');
		expect(digest.message).toContain("its thread has not started a new turn since");
		// Given up: tombstoned, never sent, never held again.
		expect(r.store.wakes.find(t2)).toMatchObject({ status: "cancelled" });
		expect(r.store.wakes.known(t2)).toBe(true);
		expect(r.events.some((e) => e.event === "held-given-up")).toBe(true);
	});

	test("a settled thread's held report is given up; when nothing else is held the Steward gets no turn", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t5");
		await r.until("held", () => r.held().length === 1);
		r.fake.emit({ kind: "state", thread: { ...thread("t5", "completed"), settled: true } });
		await r.until("marked", () => r.store.wakes.superseded().length === 1);
		expect(r.store.wakes.superseded()[0]!.why).toBe("settled");
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.engine.tick();
		expect(posts(r).filter((w) => w.message.includes('thread "Thread t5"'))).toEqual([]);
		expect(r.held()).toEqual([]);
	});
});

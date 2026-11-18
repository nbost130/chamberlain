/** Held turn-end reports and what happens to their thread while they wait: a new turn keeps the report, settling gives it up. */
import { describe, expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);
const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));

describe("held turn-end reports and their thread", () => {
	const ended = (r: ReturnType<typeof rig>, id: string) => {
		r.fake.threads.set(id, {
			instruction: { items: [{ ...stewardSigned, id: `s-${id}` }], state: "complete", byMachine: false },
			lastMessage: `${id} finished the work.`,
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running") });
		r.fake.emit({ kind: "state", thread: thread(id, "completed") });
	};

	test("a new turn never drops a held report: it still arrives, saying its thread moved on", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t2");
		ended(r, "t3");
		await r.until("two held", () => r.held().length === 2);
		// t2 starts another turn while the Steward is busy (a quick fix whose own report may never come).
		r.fake.emit({ kind: "state", thread: thread("t2", "running") });
		await r.engine.tick();
		expect(r.store.wakes.superseded()).toEqual([]);
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.until("the digest", () => posts(r).some((w) => w.deliveryId.startsWith("digest:")));
		const digest = posts(r).find((w) => w.deliveryId.startsWith("digest:"))!;
		expect(digest.message).toContain('thread "Thread t2"');
		expect(digest.message).toContain('thread "Thread t3"');
		expect(digest.message).toMatch(/its thread started a new turn at \d\d:\d\d UTC, after this report/);
	});

	test("a settled thread's held report is given up for good; when nothing else is held the Steward gets no turn", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.setBusy("busy");
		ended(r, "t5");
		await r.until("held", () => r.held().length === 1);
		const id = r.held()[0]!.deliveryId;
		r.fake.emit({ kind: "state", thread: { ...thread("t5", "completed"), settled: true } });
		await r.until("marked", () => r.store.wakes.superseded().length === 1);
		expect(r.store.wakes.superseded()[0]!.why).toBe("settled");
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.engine.tick();
		expect(posts(r).filter((w) => w.message.includes('thread "Thread t5"'))).toEqual([]);
		expect(r.held()).toEqual([]);
		expect(r.store.wakes.find(id)).toMatchObject({ status: "cancelled" });
		expect(r.store.wakes.find(id)!.deliveryId).toMatch(/^superseded:[0-9a-f]{16}$/);
		expect(r.store.wakes.superseded()).toEqual([]);
		expect(r.events.some((e) => e.event === "held-given-up")).toBe(true);
	});

	test("a dry run writes no mark", async () => {
		const r = rig({ steward: "steward-1", dry: true });
		r.fake.setBusy("busy");
		// A report a live run held before this dry run started.
		r.store.wakes.hold({ deliveryId: "t6:ended:1", message: "report", queuedAt: 1, kind: "turn_ended", thread: "t6" });
		await r.until("watching", () => r.engine.watchers[0]!.connected);
		r.fake.emit({ kind: "state", thread: thread("t6", "completed") });
		await r.until("the watcher saw it", () => r.engine.watchers[0]!.states.has("t6"));
		r.fake.emit({ kind: "state", thread: { ...thread("t6", "completed"), settled: true } });
		await r.until("the watcher saw it settled", () => r.engine.watchers[0]!.states.get("t6")?.settled === true);
		expect(r.store.wakes.superseded()).toEqual([]);
	});
});

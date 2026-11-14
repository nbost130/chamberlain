/** engine, continued: see engine.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { useCoreEngineExtraFixtures } from "../testing/core-engine-extra-fixtures.ts";
import { withDeliveryId } from "./deliver.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, question, STREAM, make, waitingOn, pointerQueued, rightsThenRow } =
	useCoreEngineExtraFixtures(createEngine);

describe("stalled-thread recovery, end to end through the fake", () => {
	test("a never-retry failure wakes the Steward at once, naming why, and sends nothing", async () => {
		const x = make();
		x.failRun("t1", "run-1", {
			runId: "run-1",
			class: "provider_error",
			code: "api_error_403",
			message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		});
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain("not retried automatically: a 403 / Cloudflare block");
		await x.quiet();
		expect(x.fake.sends).toEqual([]);
	});

	test("a waiting thread, and the Steward's own thread, are never retried", async () => {
		const x = make();
		x.failRun("w", "run-1", STREAM, { backgroundTasks: 1 });
		await x.until("the wake", () => x.fake.wakes.length === 1);
		expect(x.fake.wakes[0]!.message).toContain(
			"not retried automatically: waiting: a watch, gate or background task is parked",
		);
		await x.quiet(100);
		expect(x.fake.sends).toEqual([]);
	});

	test("three failures of one kind raise exactly one alarm through the decision queue, and stop every retry", async () => {
		const x = make();
		for (const [i, id] of ["a", "b", "c"].entries())
			x.failRun(id, `run-${i + 1}`, { ...STREAM, runId: `run-${i + 1}` });
		await x.until("the alarm", () => x.asked.length === 1);
		x.failRun("d", "run-4", { ...STREAM, runId: "run-4" });
		await x.quiet(250);
		expect(x.asked).toHaveLength(1);
		expect(x.asked[0]).toMatchObject({ kind: "only-you", tag: "Outage" });
		expect(x.asked[0]!.title).toContain("3");
		expect(x.fake.sends).toEqual([]);
		expect(x.fake.wakes).toEqual([]);
	});

	test("an adapter that cannot read a failure keeps the plain failed wake, with no retry", async () => {
		const r = rig({ capabilities: ["send"] });
		r.fake.emit({ kind: "state", thread: thread("t1", "running") });
		r.fake.emit({ kind: "state", thread: thread("t1", "failed", { latestRunId: "run-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("run failed.");
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		expect(r.fake.sends).toEqual([]);
	});
});

describe("recovery is OFF unless asked for, and the production launcher asks only with `recover` (CHAMBERLAIN_RECOVER=1 or config.json)", () => {
	test("an engine built without `recover` keeps the plain failed wake and retries nothing", async () => {
		const r = rig();
		r.fake.threads.set("t1", {
			failure: { runId: "run-1", class: "unknown", message: "The provider event stream closed unexpectedly." },
		});
		r.fake.emit({ kind: "state", thread: thread("t1", "running", { latestRunId: "run-1" }) });
		r.fake.emit({ kind: "state", thread: thread("t1", "failed", { latestRunId: "run-1" }) });
		await r.until("the wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("run failed.");
		expect(r.fake.wakes[0]!.message).not.toContain("not retried automatically");
		await r.quiet(150);
		expect(r.fake.sends).toEqual([]);
		expect(r.store.state.get("recover")).toBeUndefined();
	});
	test("the daemon launcher turns it on only for `recover` being true", () => {
		const src = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
		expect(src).toContain('recover: setting("recover", CONF) === true');
	});
});

describe("wakes carry the rights and rulings only when they changed", () => {
	const waitingOn = (r: ReturnType<typeof rig>, id: string, req: string) => {
		r.fake.threads.set(id, { waiting: [{ ...question, requestId: req }] });
		r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
	};
	test("unchanged rights give the one-line pointer, and a toggle of away mode never re-sends the block", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the second wake", () => r.fake.wakes.length === 2);
		const pointer = r.fake.wakes[1]!.message.split("\n").filter((l) =>
			l.startsWith("Decision rights and rulings unchanged since"),
		);
		expect(pointer).toHaveLength(1);
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights (standing rules):");
		// Away on: the mandate rides the wake, the block still does not.
		r.store.away.enter({ enteredAt: new Date().toISOString(), words: "back at five" });
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the away wake", () => r.fake.wakes.length === 3);
		expect(r.fake.wakes[2]!.message).not.toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[2]!.message).toContain(pointer[0]!);
		expect(r.fake.wakes[2]!.message).toContain("back at five");
		// Away off: still the pointer.
		r.store.away.exit(new Date().toISOString());
		r.fake.probe = { readable: true, contextTokens: 4000 };
		waitingOn(r, "t4", "req-4");
		await r.until("the wake after", () => r.fake.wakes.length === 4);
		expect(r.fake.wakes[3]!.message).not.toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[3]!.message).toContain(pointer[0]!);
	});

	test("a changed ruling sends the full block again", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the second wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights (standing rules):");
		r.priv("decision-rights.md", "The Steward may merge green PRs and nothing else.");
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the third wake", () => r.fake.wakes.length === 3);
		expect(r.fake.wakes[2]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[2]!.message).toContain("and nothing else.");
	});

	test("a full-block wake that is dead-lettered leaves the record unset, and the next wake carries the full block again", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		r.fake.setWakeStatus(() => 503);
		waitingOn(r, "t1", "req-1");
		await r.until("the dead letter", () => r.store.wakes.rows("dead_letter").length === 1);
		expect(r.fake.attempts).toBe(3);
		expect(r.fake.wakes).toEqual([]);
		// The block it carried never reached the Steward, so nothing says the Steward holds it.
		expect(r.store.state.get("rights-sent")).toBeUndefined();
		r.fake.setWakeStatus(() => 202);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[0]!.message).not.toContain("Decision rights and rulings unchanged since");
	});
});

describe("a queued rights pointer is checked against the Steward it is about to reach", () => {
	test("a new Steward thread before it is sent: the full rights go first, then the pointer row exactly as queued", async () => {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
		expect(r.fake.wakes[2]!.message).toContain("threadId: t2");
		const logged = r.events.find((e) => e.event === "rights-first");
		expect(logged).toMatchObject({ deliveryId: row.deliveryId, first: r.fake.wakes[1]!.deliveryId });
		expect(String(logged!.reason)).toContain("Steward thread");
		// The new Steward now holds them: the next wake is a pointer again, with nothing ahead of it.
		r.fake.probe = { readable: true, contextTokens: 3000 };
		waitingOn(r, "t3", "req-3");
		await r.until("the fourth wake", () => r.fake.wakes.length === 4);
		expect(r.fake.wakes[3]!.message).toContain("Decision rights and rulings unchanged since");
		expect(r.fake.wakes[3]!.deliveryId).not.toContain("rights-first");
	});

	test("a new Steward session in the same thread sends the rights first too", async () => {
		const { r, row } = await pointerQueued();
		r.fake.transcript = { ...r.fake.transcript, session: "session-2" };
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
		expect(String(r.events.find((e) => e.event === "rights-first")!.reason)).toContain("session");
	});

	test("a compaction that cleared the record sends the rights first too", async () => {
		const { r, row } = await pointerQueued();
		r.fake.probe = { readable: true, contextTokens: 10 };
		await r.engine.tick();
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the rights and the row", () => r.fake.wakes.length === 3);
		rightsThenRow(r, row);
	});

	test("a full wake in flight, the compaction asked for, the full wake lands: the next wake carries the full rights, never a bare pointer", async () => {
		const r = rig({ steward: "steward-1", compactAt: 5000 });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		let release!: () => void,
			started = false;
		const open = new Promise<void>((res) => {
			release = res;
		});
		const send = r.fake.wake.send;
		r.fake.wake.send = async (id, message) => {
			if (!started) {
				started = true;
				await open;
			}
			return send(id, message);
		};
		waitingOn(r, "t1", "req-1");
		await r.until("the full wake in flight", () => started);
		// Past the size limit while the full wake's POST is open: the compaction is asked for, and waits behind it in the relay's queue.
		r.fake.probe = { readable: true, contextTokens: 6000 };
		const ticking = r.engine.tick();
		await r.until("the compaction asked for", () => r.events.some((e) => e.event === "fire" && e.kind === "compact"));
		release();
		await ticking;
		await r.until("the full wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.compactions).toHaveLength(1);
		// The full wake landed before the compaction's job, which then bumped the epoch: no record survives it.
		expect(r.store.state.get("rights-sent")).toEqual({ epoch: 1 });
		r.fake.probe = { readable: true, contextTokens: 1500 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).toContain("Decision rights (standing rules):");
		expect(r.fake.wakes[1]!.message).not.toContain("Decision rights and rulings unchanged since");
	});

	test("the plain case: a full wake delivered, then a compaction: the next wake carries the full rights", async () => {
		const r = rig({ steward: "steward-1", compactAt: 5000 });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the full wake", () => r.fake.wakes.length === 1);
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-1", epoch: 0 });
		r.fake.probe = { readable: true, contextTokens: 6000 };
		await r.engine.tick();
		expect(r.fake.compactions).toHaveLength(1);
		r.fake.probe = { readable: true, contextTokens: 6500 };
		waitingOn(r, "t2", "req-2");
		await r.until("the next wake", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.message).toContain("Decision rights (standing rules):");
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-1", epoch: 1 });
	});

	test("the same Steward and record: the pointer is sent as queued, with no extra wake", async () => {
		const { r, row } = await pointerQueued();
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the pointer", () => r.fake.wakes.length === 2);
		expect(r.fake.wakes[1]!.deliveryId).toBe(row.deliveryId);
		expect(r.fake.wakes[1]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		await r.engine.tick();
		expect(r.fake.wakes).toHaveLength(2);
		expect(r.store.wakes.rows("all").some((w) => w.deliveryId.includes(":rights-first:"))).toBe(false);
		expect(r.events.some((e) => e.event === "rights-first")).toBe(false);
	});

	test("the rights went, the row failed, the Steward changed before the retry: the row waits for the NEW Steward's rights, then goes as queued", async () => {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		r.fake.setWakeStatus((id) => (id === row.deliveryId ? 503 : 202));
		r.fake.setWakeReady(true);
		await r.engine.tick();
		await r.until("the row's failed attempt", () => (r.store.wakes.find(row.deliveryId)?.attempts ?? 0) >= 1);
		expect(r.fake.wakes.map((w) => w.deliveryId).slice(1)).toHaveLength(1);
		const first = r.fake.wakes[1]!;
		expect(first.deliveryId.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		// Replaced again before the retry: the rights steward-2 got prove nothing for steward-3.
		r.priv("steward-thread", "steward-3");
		r.fake.setWakeStatus(() => 202);
		await r.engine.tick();
		await r.until("the row", () => r.store.wakes.find(row.deliveryId)?.status === "delivered");
		const ids = r.fake.wakes.map((w) => w.deliveryId).slice(1);
		expect(ids).toHaveLength(3);
		expect(ids[1]!.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		expect(ids[1]).not.toBe(first.deliveryId);
		expect(ids[2]).toBe(row.deliveryId);
		expect(r.fake.wakes[3]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		expect(r.store.state.get("rights-sent")).toMatchObject({ steward: "steward-3", session: "session-1" });
	});
});

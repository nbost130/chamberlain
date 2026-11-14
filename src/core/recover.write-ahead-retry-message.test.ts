/** recover, continued: see recover.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { rig, t } from "../testing/core-recover-fixtures.ts";
import { type Fault, MATRIX } from "../testing/core-recover-matrix-fixtures.ts";
import { DEFAULT_RECOVER_TIMING, MIN } from "./recover-classify.ts";
import { memoryRecoverStore, type RecoverDeps, type RecoverStore, retrySeed } from "./recover-state.ts";

describe("write-ahead, and a retry message id that is the same after a restart", () => {
	/** A store that stops persisting at the moment of a crash, as a dead process would. */
	const crashable = () => {
		const inner = memoryRecoverStore();
		const dead = { v: false };
		const store: RecoverStore = {
			load: () => inner.load(),
			save: (s) => {
				if (!dead.v) inner.save(s);
			},
		};
		return { inner, dead, store };
	};
	const failStream = (runId: string) => ({ runId, message: "The provider event stream closed unexpectedly." });

	test("crash after the send was accepted, before anything more was recorded: after the restart the retry fails, and there is exactly one ping and one judge call", async () => {
		const c = crashable();
		const a = rig({
			store: c.store,
			onPing: () => {
				c.dead.v = true;
				a.r.stop();
			},
		});
		await a.fail("t1", failStream("run-1"));
		await a.advance(4 * MIN);
		expect(a.pings).toHaveLength(1);
		// T3 accepted the message: a run began on the thread, and the process died before it could write anything else.
		a.states.set("t1", t({ status: "running", latestRunId: "run-2" }));
		const b = rig({ store: c.inner, share: a });
		b.r.restore();
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
		expect(b.pings).toEqual([]);
		// The retry fails.
		const h = await b.fail("t1", failStream("run-2"));
		expect(h).toMatchObject({ action: "verdict" });
		expect(a.pings.length + b.pings.length).toBe(1);
		expect(b.judged).toHaveLength(1);
	});

	test("the same crash, but the message never reached T3: the restart re-sends the very same message id, and the failure after it goes to the judge", async () => {
		const c = crashable();
		const a = rig({
			store: c.store,
			onPing: () => {
				c.dead.v = true;
				a.r.stop();
			},
		});
		await a.fail("t1", { ...failStream("run-1"), ordinal: 981 });
		await a.advance(4 * MIN);
		expect(a.pings).toHaveLength(1);
		const b = rig({ store: c.inner, share: a });
		b.r.restore();
		await b.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
		expect(b.pings).toHaveLength(1);
		expect(b.pings[0]!.seed).toBe(a.pings[0]!.seed);
		expect(a.pings[0]!.seed).toBe("recover:t1:981");
		expect(await b.fail("t1", failStream("run-2"))).toMatchObject({ action: "verdict" });
		expect(b.judged).toHaveLength(1);
	});

	test("the attempt is on disk before the message is sent: a state read at the moment of the send already counts it", async () => {
		const inner = memoryRecoverStore();
		let seen: unknown;
		const a = rig({
			store: inner,
			onPing: () => {
				seen = JSON.parse(JSON.stringify(inner.load()));
			},
		});
		await a.fail("t1", failStream("run-1"));
		await a.advance(4 * MIN);
		const rec = (seen as { threads: Record<string, { pings: number; retried?: { runId: string }; pending?: unknown }> })
			.threads.t1!;
		expect(rec.pings).toBe(1);
		expect(rec.retried?.runId).toBe("run-1");
		expect(rec.pending).toBeDefined();
	});

	test("a retry the server refused outright ('not sent: ...') is withdrawn, so the next failure is a first failure again", async () => {
		let refuse = true;
		const x = rig({
			ping: () =>
				refuse
					? { ok: false, detail: "not sent: the thread is waiting on a card, approval or question" }
					: { ok: true, detail: "sent" },
		});
		await x.fail("t1", failStream("run-1"));
		await x.advance(4 * MIN);
		expect(x.wakes).toHaveLength(1);
		refuse = false;
		x.states.set("t1", t({ latestRunId: "run-1" }));
		expect((await x.fail("t1", failStream("run-2"))).action).toBe("retry-scheduled");
	});

	test("a send that failed in an unknown way stays counted, so a repeat is never a second first ping", async () => {
		const x = rig({ ping: () => ({ ok: false, detail: "send timed out after 10000 ms" }) });
		await x.fail("t1", failStream("run-1"));
		await x.advance(4 * MIN);
		expect(x.wakes).toHaveLength(1);
		expect(await x.fail("t1", failStream("run-2"))).toMatchObject({ action: "verdict" });
	});

	test("the seed is the thread and the failed run's ordinal, never random: it repeats for one failure and differs between stretches", () => {
		expect(retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 })).toBe("recover:t1:981");
		expect(retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 })).toBe(
			retrySeed("t1", { runId: "run:x:ordinal:981", ordinal: 981 }),
		);
		expect(retrySeed("t1", { runId: "a", ordinal: 981 })).not.toBe(retrySeed("t1", { runId: "b", ordinal: 1200 }));
		expect(retrySeed("t2", { runId: "a", ordinal: 981 })).not.toBe(retrySeed("t1", { runId: "a", ordinal: 981 }));
		expect(retrySeed("t1", { runId: "run-7" })).toBe("recover:t1:run-7");
	});
});

describe("fault injection over every crash and failure point of the recovery sequence", () => {
	for (const row of MATRIX)
		test(row.name, async () => {
			const inner = memoryRecoverStore();
			const delivered: { seed: string; by: string }[] = [];
			const stream = (runId: string) => ({
				runId,
				ordinal: runId === "run-1" ? 1 : 2,
				message: "The provider event stream closed unexpectedly.",
			});
			/** One process: its store drops every write after its death, and its effects after death never happen (a dead process does not wake anyone). */
			const process_ = (side: "A" | "B") => {
				const dead = { v: false };
				let wroteAhead = false;
				const faulty = (row.on ?? "A") === side;
				const store: RecoverStore = {
					load: () => inner.load(),
					save: (s) => {
						if (dead.v) return;
						const writeAhead = Object.values(s.threads).some((th) => th.pending?.attempt);
						if (writeAhead && !wroteAhead) {
							wroteAhead = true;
							if (side === "A" && row.crash === "before-save") {
								dead.v = true;
								return;
							}
							if (faulty && row.fault === "save-fails") throw Error("disk full");
						}
						inner.save(s);
					},
				};
				let faulted = false;
				/** A fault happens once, at the point under test; the retry that follows it is not faulted again. */
				const hit = (f: Fault) => {
					if (faulty && row.fault === f && !faulted) {
						faulted = true;
						return true;
					}
					return false;
				};
				const ping: NonNullable<RecoverDeps["ping"]> = async (_id, _text, seed) => {
					if (dead.v) return new Promise<never>(() => {});
					if (side === "A" && row.crash === "after-save") {
						dead.v = true;
						return new Promise<never>(() => {});
					}
					if (hit("refused"))
						return { ok: false, detail: "not sent: the thread is waiting on a card, approval or question" };
					if (hit("throws")) throw Error("socket hang up");
					if (hit("unknown-error")) return { ok: false, detail: "send timed out after 10000 ms" };
					// T3 accepts it: a run begins on the thread.
					delivered.push({ seed, by: side });
					w.states.set("t1", t({ status: "running", latestRunId: "run-2" }));
					if (side === "A" && row.crash === "send-accepted") {
						dead.v = true;
						return new Promise<never>(() => {});
					}
					if (side === "A" && row.crash === "after-send") dead.v = true;
					return { ok: true, detail: "sent" };
				};
				return { store, ping, dead };
			};
			const pa = process_("A");
			const a = rig({
				store: pa.store,
				ctxOver: {
					ping: pa.ping,
					wake: (threadId, kind, note) => {
						if (!pa.dead.v) a.wakes.push({ threadId, kind, note });
					},
				},
			});
			const w = a;
			await a.fail("t1", stream("run-1"));
			await a.advance(4 * MIN);
			if (row.crash === "after-record") pa.dead.v = true;
			let side = a;
			if (row.restart) {
				a.r.stop();
				const pb = process_("B");
				side = rig({ store: pb.store, share: a, ctxOver: { ping: pb.ping } });
				side.r.restore();
				await side.advance(DEFAULT_RECOVER_TIMING.restoreDelayMs + 1000);
			}
			// What the faulted attempt left behind.
			const th = inner.load()?.threads.t1;
			expect(delivered.length).toBe(row.sent);
			expect(new Set(delivered.map((m) => m.seed)).size).toBe(row.sent);
			if (row.sent) expect(delivered[0]!.seed).toBe("recover:t1:1");
			expect(th?.pings ?? 0).toBe(row.counters.pings);
			expect(th?.retried !== undefined).toBe(row.counters.retried);
			expect(th?.pending?.attempt).toBeUndefined();
			const wakes = [...a.wakes, ...(side === a ? [] : side.wakes)];
			if (row.wake) expect(wakes.some((x) => row.wake!.test(x.note))).toBe(true);
			else expect(wakes).toEqual([]);
			// The next failure.
			const h = await side.fail("t1", stream("run-2"));
			expect(h.action).toBe(row.next);
			const judges = side === a ? a.judged.length : side.judged.length;
			expect(judges).toBe(row.next === "verdict" ? 1 : 0);
			if (row.next === "retry-scheduled") {
				// A withdrawn or never-made attempt leaves the stall its one retry: it goes out now, and it is the only one.
				w.states.set("t1", t({ latestRunId: "run-2" }));
				await side.advance(4 * MIN);
				expect(delivered.length).toBe(1);
			} else {
				expect(delivered.length).toBeLessThanOrEqual(1);
			}
		});

	test("the matrix covers every crash point and every failure of the send, and each only once", () => {
		const crashes = new Set(MATRIX.map((r) => r.crash).filter(Boolean));
		for (const c of ["before-save", "after-save", "send-accepted", "after-send", "after-record"] as const)
			expect(crashes.has(c)).toBe(true);
		const faults = new Set(MATRIX.map((r) => r.fault).filter(Boolean));
		for (const f of ["save-fails", "refused", "throws", "unknown-error"] as const) expect(faults.has(f)).toBe(true);
		expect(new Set(MATRIX.map((r) => r.name)).size).toBe(MATRIX.length);
	});
});

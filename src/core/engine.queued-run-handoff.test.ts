/**
 * Sol round-1 properties for PR #75 / issue #74: run-scoped reports, human-successor suppress,
 * completed-only handoff, and skipped-ordinal reconciliation. These fail on 5c8f1a0c and pass after the fix.
 */
import { expect, setSystemTime, test } from "bun:test";
import { useCoreEngineFixtures } from "../testing/core-engine-fixtures.ts";
import type { TurnItem } from "./decide.ts";
import { createEngine } from "./engine.ts";
import { itemsForRun, lastCompletedForRun } from "./handoff.ts";

const { rig, thread, stewardSigned, question } = useCoreEngineFixtures(createEngine);

const id = "mcp:launch:f707bc64-review";
const PLAIN = "head df704346, checks green. No merge/deploy.";
const doneAt = Date.parse("2026-11-15T22:43:57.057Z");

async function scenario(
	body: (x: {
		r: ReturnType<typeof rig>;
		advance: (ms: number) => Promise<void>;
		state: (run: number, status?: string, over?: Record<string, unknown>) => void;
		next: (human?: boolean, ordinal?: number, status?: string) => void;
		runs: { id: string; ordinal: number; status: string }[];
		items: TurnItem[];
	}) => Promise<void>,
) {
	const original = globalThis.setTimeout;
	let now = doneAt - 1000;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let seq = 500_000;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		const n = ++seq;
		timers.set(n, { at: now + (ms ?? 0), fn });
		return n as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	setSystemTime(now);
	const advance = async (ms: number) => {
		now += ms;
		setSystemTime(now);
		for (let i = 0; i < 40; i++) {
			for (const [k, t] of timers) {
				if (t.at <= now) {
					timers.delete(k);
					t.fn();
				}
			}
			await Bun.sleep(1);
		}
	};
	const r = rig({ steward: "steward-1", quietMs: 180_000 });
	const runs: { id: string; ordinal: number; status: string }[] = [{ id: "r20", ordinal: 20, status: "running" }];
	const items: TurnItem[] = [
		{ ...stewardSigned, id: "s20", runId: "r20" },
		{ type: "assistant_message", id: "a20", runId: "r20", status: "completed", text: PLAIN },
	];
	r.fake.inspect!.instruction = async (_tid, runId) => ({
		items: runId ? itemsForRun(items, runId) : items,
		state: "complete" as const,
		byMachine: false,
	});
	r.fake.inspect!.lastMessage = async (_tid, runId) =>
		runId ? lastCompletedForRun(items, runId) : lastCompletedForRun(items, items.at(-1)?.runId ?? "");
	r.fake.inspect!.runs = async () => runs;
	const state = (run: number, status = "running", over: Record<string, unknown> = {}) =>
		r.fake.emit({ kind: "state", thread: thread(id, status, { latestRunId: `r${run}`, ...over }) });
	const next = (human = false, ordinal = 21, status = "running") => {
		runs[0]!.status = "completed";
		runs.push({ id: `r${ordinal}`, ordinal, status });
		items.push({
			...stewardSigned,
			id: `s${ordinal}`,
			runId: `r${ordinal}`,
			...(human
				? { createdBy: "user" as const, creationSource: "web", text: "continue?", updatedAt: new Date().toISOString() }
				: {}),
		});
		items.push({
			type: "assistant_message",
			id: `a${ordinal}`,
			runId: `r${ordinal}`,
			status: "completed",
			text: status === "completed" ? "run 21 final distinct" : "LIVE PARTIAL MUST NOT LEAK",
		});
	};
	try {
		await body({ r, advance, state, next, runs, items });
	} finally {
		await r.engine.stop();
		globalThis.setTimeout = original;
		setSystemTime();
	}
}

test("handoff: exact incident timestamps, duplicates and reconnect re-sighting", async () =>
	scenario(async ({ r, advance, state, next }) => {
		state(20);
		await advance(1000);
		next();
		await advance(785);
		state(21);
		state(21);
		await advance(10);
		expect(r.fake.wakes).toHaveLength(1);
		expect(r.fake.wakes[0]!.message).toContain(PLAIN);
		expect(r.fake.wakes[0]!.message).not.toContain("LIVE PARTIAL");
		r.fake.setConnected(false);
		r.fake.setConnected(true);
		state(21);
		await advance(100);
		expect(r.fake.wakes).toHaveLength(1);
	}));

test("handoff: fast successor preserves both completed reports (M1)", async () =>
	scenario(async ({ r, advance, state, next, runs, items }) => {
		state(20);
		next();
		state(21);
		runs[1]!.status = "completed";
		items[items.length - 1]!.text = "run 21 final distinct";
		state(21, "completed");
		await advance(10);
		r.clock.t += 31_000;
		await r.engine.tick();
		await advance(10);
		const messages = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(messages).toContain(PLAIN);
		expect(messages).toContain("run 21 final distinct");
	}));

test("handoff: skipped ordinals keep run N's final and schedule the intervening run (M1)", async () =>
	scenario(async ({ r, advance, state, next }) => {
		state(20);
		next(false, 21, "completed");
		next(false, 22, "running");
		state(22);
		await advance(20);
		r.clock.t += 31_000;
		await r.engine.tick();
		await advance(10);
		const messages = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(messages).toContain(PLAIN);
		expect(messages).toContain(":ended:r20:");
		expect(messages).toContain(":ended:r21:");
	}));

test("handoff: human takeover without observed idle suppresses the old report (M2)", async () =>
	scenario(async ({ r, advance, state, next }) => {
		state(20);
		next(true);
		state(21);
		await advance(10);
		expect(r.fake.wakes).toHaveLength(0);
		expect(r.events.some((e) => e.event === "skip-human-successor")).toBe(true);
	}));

test("handoff: live successor question card remains visible", async () =>
	scenario(async ({ r, advance, state, next }) => {
		state(20);
		next();
		r.fake.threads.set(id, { waiting: [question] });
		state(21, "waiting", { pendingRequestId: "req-1" });
		await advance(10);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).toContain("Merge now?");
	}));

test("handoff: idle gap and duplicate completion only wake once", async () =>
	scenario(async ({ r, advance, state, next, runs }) => {
		state(20);
		runs[0]!.status = "completed";
		state(20, "completed");
		await advance(10);
		next();
		state(21);
		state(21);
		r.fake.setConnected(false);
		r.fake.setConnected(true);
		state(21);
		await advance(100);
		expect(r.fake.wakes).toHaveLength(1);
		expect(r.fake.wakes[0]!.message).toContain(PLAIN);
	}));

for (const status of ["cancelled", "interrupted"] as const) {
	test(`handoff: ${status} run cannot be reported using an older final (M3)`, async () =>
		scenario(async ({ r, advance, state, next, runs, items }) => {
			state(20);
			next();
			runs[0]!.status = status;
			items.splice(1, 1);
			items.unshift({
				type: "assistant_message",
				id: "a19",
				runId: "r19",
				status: "completed",
				text: "OLD RUN19 FINAL",
			});
			runs.unshift({ id: "r19", ordinal: 19, status: "completed" });
			state(21);
			await advance(10);
			expect(
				r.fake.wakes.some((w) => w.deliveryId.includes(":ended:r20:") && w.message.includes("OLD RUN19 FINAL")),
			).toBe(false);
			expect(r.events.some((e) => e.event === "skip-not-completed")).toBe(true);
		}));
}

for (const work of ["child", "subagent", "background"] as const) {
	test(`handoff: queued handoff with ${work} retains settlement`, async () =>
		scenario(async ({ r, advance, state, next }) => {
			if (work === "child") r.fake.emit({ kind: "state", thread: thread("child", "running", { parentThreadId: id }) });
			if (work === "subagent") r.fake.threads.set(id, { subagents: 1 });
			const over = work === "background" ? { backgroundWork: 1 } : {};
			state(20, "running", over);
			next();
			state(21, "running", over);
			await advance(10);
			expect(r.fake.wakes).toHaveLength(0);
			expect(r.events.some((e) => e.event === "fire")).toBe(false);
		}));
}

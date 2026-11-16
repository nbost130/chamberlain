/** Shared fake-clock scenario for queued-handoff engine tests (issue #74 / PR #75). */
import { setSystemTime } from "bun:test";
import type { TurnItem } from "../core/decide/decide.ts";
import { itemsForRun, lastCompletedForRun } from "../core/steward/handoff.ts";
import type { useCoreEngineFixtures } from "./core-engine-fixtures.ts";

export const HANDOFF_THREAD = "mcp:launch:f707bc64-review";
export const HANDOFF_PLAIN = "head df704346, checks green. No merge/deploy.";
const doneAt = Date.parse("2026-11-15T22:43:57.057Z");

type Fixtures = ReturnType<typeof useCoreEngineFixtures>;

export async function handoffScenario(
	fixtures: Fixtures,
	body: (x: {
		r: ReturnType<Fixtures["rig"]>;
		advance: (ms: number) => Promise<void>;
		state: (run: number, status?: string, over?: Record<string, unknown>) => void;
		next: (human?: boolean, ordinal?: number, status?: string) => void;
		runs: { id: string; ordinal: number; status: string }[];
		items: TurnItem[];
	}) => Promise<void>,
) {
	const { rig, thread, stewardSigned } = fixtures;
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
		{ type: "assistant_message", id: "a20", runId: "r20", status: "completed", text: HANDOFF_PLAIN },
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
		r.fake.emit({ kind: "state", thread: thread(HANDOFF_THREAD, status, { latestRunId: `r${run}`, ...over }) });
	const next = (human = false, ordinal = 21, status = "running") => {
		const prev = runs.at(-1);
		if (prev) prev.status = "completed";
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

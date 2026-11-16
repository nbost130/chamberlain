/**
 * Sol round-2 / R2-2 probes for PR #75: coherent handoff confirmation and terminal rejection
 * that must not revive as an ordinary completion when a state arrives mid-read.
 */
import { expect, test } from "bun:test";
import { useCoreEngineFixtures } from "../testing/core-engine-fixtures.ts";
import { handoffScenario, HANDOFF_PLAIN as PLAIN } from "../testing/queued-run-handoff-scenario.ts";
import { createEngine } from "./engine.ts";

const fixtures = useCoreEngineFixtures(createEngine);
const scenario = (body: Parameters<typeof handoffScenario>[1]) => handoffScenario(fixtures, body);

test("handoff r2: skipped ordinal survives newest run completing before debounce (M1)", async () =>
	scenario(async ({ r, state, next, runs, items, advance }) => {
		state(20);
		next(false, 21, "completed");
		next(false, 22, "running");
		state(22);
		runs[2]!.status = "completed";
		items.at(-1)!.text = "RUN22 FINAL";
		state(22, "completed");
		await advance(20);
		r.clock.t += 31_000;
		await r.engine.tick();
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).toContain(PLAIN);
		expect(all).toContain("RUN22 FINAL");
		expect(all).toContain("run 21 final distinct");
	}));

test("handoff r2: fast human successor does not admit old handoff (M2)", async () =>
	scenario(async ({ r, state, next, runs, items, advance }) => {
		state(20);
		next(true);
		state(21);
		runs[1]!.status = "completed";
		items.at(-1)!.text = "HUMAN RUN FINAL";
		state(21, "completed");
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).not.toContain(PLAIN);
	}));

test("handoff r2: human successor appearing between runs and history reads suppresses handoff (M2)", async () =>
	scenario(async ({ r, state, next, advance }) => {
		state(20);
		next();
		state(21);
		const orig = r.fake.inspect!.instruction!;
		let changed = false;
		r.fake.inspect!.runs = async () => [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		r.fake.inspect!.instruction = async (tid, runId) => {
			if (!runId && !changed) {
				changed = true;
				next(true, 22);
				state(22);
			}
			return orig(tid, runId);
		};
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).not.toContain(PLAIN);
	}));

test("handoff r2: unreadable runs cannot certify cancelled run as completed (M3)", async () =>
	scenario(async ({ r, state, next, runs, advance }) => {
		state(20);
		next();
		runs[0]!.status = "cancelled";
		r.fake.inspect!.runs = async () => {
			throw Error("projection temporarily unavailable");
		};
		state(21);
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).not.toContain(PLAIN);
		expect(r.events.some((e) => e.event === "skip-handoff-unconfirmed")).toBe(true);
	}));

/** Sol R2-2 probes from review-r2-extra.test.ts (fail on e5f958e0, pass after terminal disposition). */
test("handoff r2: duplicate state during human-skip read cannot revive rejected handoff", async () =>
	scenario(async ({ r, state, next, runs, items, advance }) => {
		state(20);
		next(true);
		state(21, "queued");
		let changed = false;
		r.fake.inspect!.handoffSnapshot = async () => {
			if (!changed) {
				changed = true;
				state(21);
			}
			return structuredClone({ runs, items });
		};
		await advance(20);
		expect(r.events.some((e) => e.event === "skip-human-successor")).toBe(true);
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).not.toContain(PLAIN);
	}));

test("handoff r2: duplicate state during cancelled-skip read cannot revive rejected handoff", async () =>
	scenario(async ({ r, state, next, runs, items, advance }) => {
		state(20);
		next();
		runs[0]!.status = "cancelled";
		state(21, "queued");
		let changed = false;
		r.fake.inspect!.handoffSnapshot = async () => {
			if (!changed) {
				changed = true;
				state(21, "running");
			}
			return structuredClone({ runs, items });
		};
		await advance(20);
		expect(r.events.some((e) => e.event === "skip-not-completed")).toBe(true);
		await advance(20);
		const all = [...r.fake.wakes.map((w) => w.message), ...r.held().map((w) => JSON.stringify(w))].join("\n");
		expect(all).not.toContain(PLAIN);
	}));

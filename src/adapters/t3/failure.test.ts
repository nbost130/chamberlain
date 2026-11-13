import { describe, expect, test } from "bun:test";
import { failureOf, lookOf } from "./failure.ts";

const run = (id: string, ordinal: number, status: string) => ({ id, ordinal, status });
const err = (runId: string, failure: Record<string, unknown>) => ({ type: "error", runId, failure });

describe("failureOf: T3's projection to a RunFailure", () => {
	test("the newest failed run, with its error's class, code, message, retryable flag and reset time", () => {
		const f = failureOf([run("r1", 1, "failed"), run("r2", 2, "failed"), run("r3", 3, "completed")], [err("r1", { message: "old" }), err("r2", { class: "usage_limit", code: "api_error_429", retryable: true, message: "rate limit", resetAt: "2026-11-13T13:00:00Z" })]);
		expect(f).toEqual({ runId: "r2", class: "usage_limit", code: "api_error_429", message: "rate limit", retryable: true, resetAt: "2026-11-13T13:00:00Z" });
	});
	test("no failed run: nothing", () => expect(failureOf([run("r1", 1, "completed")], [])).toBeUndefined());
	test("a failed run with no error item still names the run, with an empty message", () => expect(failureOf([run("r1", 1, "failed")], [])).toEqual({ runId: "r1", message: "" }));
	test("an interrupt request on the failed run marks it interrupted", () => {
		expect(failureOf([run("r1", 1, "failed")], [{ type: "run_interrupt_request", runId: "r1" }, err("r1", { message: "Provider turn failed." })])?.interrupted).toBe(true);
		expect(failureOf([run("r2", 2, "failed")], [{ type: "run_interrupt_request", runId: "r1" }])?.interrupted).toBeUndefined();
	});
	test("another run's error is not this run's", () => expect(failureOf([run("r2", 2, "failed")], [err("r1", { message: "other" })])?.message).toBe(""));
});

describe("lookOf: the projection read right before a ping", () => {
	test("the newest run and its status", () => {
		expect(lookOf([run("r1", 1, "failed"), run("r2", 2, "completed")], [])).toEqual({ latestRunId: "r2", latestStatus: "completed", active: false, waiting: false });
	});
	test("a run going, in any live status, is active", () => {
		for (const status of ["queued", "preparing", "starting", "running", "waiting"]) expect(lookOf([run("r1", 1, "failed"), run("r2", 2, status)], []).active).toBe(true);
	});
	test("any item still waiting is a card, approval or question open", () => {
		expect(lookOf([run("r1", 1, "failed")], [{ status: "completed" }, { status: "waiting" }]).waiting).toBe(true);
		expect(lookOf([run("r1", 1, "failed")], [{ status: "completed" }]).waiting).toBe(false);
	});
	test("no runs: no newest run", () => expect(lookOf([], [])).toEqual({ active: false, waiting: false }));
});

import { describe, expect, test } from "bun:test";
import type { TurnItem } from "./decide.ts";
import { endedRunId, handoffAllowed, interveningCompleted, lastCompletedForRun } from "./handoff.ts";

describe("endedRunId", () => {
	test("reads the run id from a turn_ended key", () => {
		expect(endedRunId("mcp:t:ended:r20")).toBe("r20");
		expect(endedRunId("mcp:launch:f707bc64-review:ended:r20")).toBe("r20");
		expect(endedRunId("t:ended:1763247837057")).toBeUndefined();
		expect(endedRunId("t:input:req-1")).toBeUndefined();
	});
});

describe("lastCompletedForRun", () => {
	test("never returns another run's final", () => {
		const items = [
			{ type: "assistant_message", runId: "r19", status: "completed", text: "OLD" },
			{ type: "assistant_message", runId: "r21", status: "completed", text: "NEW" },
		];
		expect(lastCompletedForRun(items, "r20")).toBe("");
		expect(lastCompletedForRun(items, "r19")).toBe("OLD");
	});
});

describe("handoffAllowed", () => {
	const steward: TurnItem = {
		type: "user_message",
		id: "s21",
		runId: "r21",
		createdBy: "agent",
		creationSource: "mcp",
		text: "continue",
	};
	const human: TurnItem = {
		type: "user_message",
		id: "h21",
		runId: "r21",
		createdBy: "user",
		creationSource: "web",
		text: "continue?",
	};

	test("without runs the gate stays open", () => {
		expect(handoffAllowed(undefined, [], "r20", true)).toBe("ok");
		expect(handoffAllowed([], [], "r20", true)).toBe("ok");
	});

	test("rejects a prior run that did not complete", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "cancelled" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		expect(handoffAllowed(runs, [steward], "r20", true)).toBe("skip-not-completed");
	});

	test("rejects a human-started LIVE successor", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		expect(handoffAllowed(runs, [human], "r20", true)).toBe("skip-human-successor");
		expect(handoffAllowed(runs, [steward], "r20", true)).toBe("ok");
	});

	test("idle-gap completions are not judged by the successor", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		expect(handoffAllowed(runs, [human], "r20", false)).toBe("ok");
	});
});

describe("interveningCompleted", () => {
	test("names completed runs the shell skipped between from and the live successor", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "completed" },
			{ id: "r22", ordinal: 22, status: "running" },
		];
		expect(interveningCompleted(runs, "r20")).toEqual(["r21"]);
		expect(interveningCompleted(runs, "r21")).toEqual([]);
	});
});

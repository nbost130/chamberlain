import { describe, expect, test } from "bun:test";
import type { TurnItem } from "../decide/decide.ts";
import { confirmHandoff, endedRunId, interveningCompleted, lastCompletedForRun } from "./handoff.ts";

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

describe("confirmHandoff", () => {
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
	const human22: TurnItem = { ...human, id: "h22", runId: "r22" };
	const record = { threadId: "t", runId: "r20", successorId: "r21", disposition: "pending" as const };

	test("idle-gap with no record goes without a runs check", () => {
		expect(confirmHandoff({ kind: "failed", error: "x" }, "r20", undefined)).toEqual({
			action: "go",
			intervening: [],
		});
	});

	test("a rejected record never returns go, even with a healthy observation", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		const ok = { kind: "ok" as const, runs, items: [steward] };
		expect(confirmHandoff(ok, "r20", { ...record, disposition: "rejected-human" })).toEqual({
			action: "skip",
			reason: "skip-human-successor",
		});
		expect(confirmHandoff(ok, "r20", { ...record, disposition: "rejected-not-completed" })).toEqual({
			action: "skip",
			reason: "skip-not-completed",
		});
	});

	test("unsupported adapters take the compatibility path", () => {
		expect(confirmHandoff({ kind: "unsupported" }, "r20", record)).toEqual({ action: "go", intervening: [] });
	});

	test("a failed or empty capable read leaves the handoff unconfirmed", () => {
		expect(confirmHandoff({ kind: "failed", error: "down" }, "r20", record)).toEqual({
			action: "retry",
			reason: "skip-handoff-unconfirmed",
		});
		expect(confirmHandoff({ kind: "ok", runs: [], items: [] }, "r20", record)).toEqual({
			action: "retry",
			reason: "skip-handoff-unconfirmed",
		});
	});

	test("rejects a prior run that did not complete", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "cancelled" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		expect(confirmHandoff({ kind: "ok", runs, items: [steward] }, "r20", record)).toEqual({
			action: "skip",
			reason: "skip-not-completed",
		});
	});

	test("rejects a human-started causing successor even after that successor completed", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "completed" },
		];
		expect(confirmHandoff({ kind: "ok", runs, items: [human] }, "r20", record)).toEqual({
			action: "skip",
			reason: "skip-human-successor",
		});
	});

	test("rejects a human tip that arrived after the recorded successor", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "running" },
		];
		expect(confirmHandoff({ kind: "ok", runs, items: [steward, human22] }, "r20", record, "r22")).toEqual({
			action: "skip",
			reason: "skip-human-successor",
		});
	});

	test("reconciles skipped completed runs whether or not the tip is still LIVE", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "completed" },
			{ id: "r22", ordinal: 22, status: "completed" },
		];
		expect(
			confirmHandoff({ kind: "ok", runs, items: [steward, { ...steward, id: "s22", runId: "r22" }] }, "r20", {
				...record,
				successorId: "r22",
			}),
		).toEqual({ action: "go", intervening: ["r21"] });
	});
});

describe("interveningCompleted", () => {
	test("names completed runs between from and until, including a completed tip", () => {
		const runs = [
			{ id: "r20", ordinal: 20, status: "completed" },
			{ id: "r21", ordinal: 21, status: "completed" },
			{ id: "r22", ordinal: 22, status: "completed" },
		];
		expect(interveningCompleted(runs, "r20", "r22")).toEqual(["r21"]);
		expect(interveningCompleted(runs, "r20")).toEqual(["r21"]);
	});
});

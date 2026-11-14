import { describe, expect, test } from "bun:test";
import { failedRead, type InstructionRead, skipEvent } from "./history";

describe("skipEvent", () => {
	const read = (state: InstructionRead["state"]): InstructionRead => ({ items: [], state, byMachine: false });
	test("only a complete read can say there is nothing to report", () => {
		expect(skipEvent(read("complete"), "skip-turn-ended")).toBe("skip-turn-ended");
		expect(skipEvent(read("failed"), "skip-turn-ended")).toBe("skip-read-failed");
		expect(skipEvent(read("truncated"), "skip-report-superseded")).toBe("skip-read-truncated");
	});
});

test("failedRead says why, and counts as a failed read", () => {
	const r = failedRead("not connected");
	expect(r).toEqual({ items: [], state: "failed", error: "not connected", byMachine: false });
	expect(skipEvent(r, "skip-turn-ended")).toBe("skip-read-failed");
});

import { describe, expect, test } from "bun:test";
import { peekLines } from "./peek.ts";

describe("peekLines", () => {
	const items = [
		{ type: "user_message", createdBy: "user", text: "first", updatedAt: "2026-11-06T17:00:00Z" },
		{ type: "reasoning", text: "hidden" },
		{ type: "command_execution", text: "$ noise" },
		{ type: "assistant_message", text: "a\n\nreply", updatedAt: "2026-11-06T17:01:00Z" },
		{ type: "user_message", createdBy: "agent", text: "from another thread" },
	];
	test("keeps only what was said, flat, and names who said it", () => {
		expect(peekLines(items, 3)).toEqual([
			"17:00 the operator: first",
			"17:01 thread: a reply",
			"--:-- agent: from another thread",
		]);
	});
	test("keeps the end of a long message, because that is where threads ask", () => {
		expect(peekLines([{ type: "assistant_message", text: "x".repeat(50) + "ask" }], 1, 5)[0]).toContain(
			"xxask [end of 53]",
		);
	});
	test("shows an open card", () => {
		expect(peekLines([...items, { type: "user_input_request", status: "waiting" }], 1).at(-1)).toContain("WAITING: 1");
	});
});

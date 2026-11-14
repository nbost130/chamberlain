/** route, continued: see route.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { parseAsk } from "../ask-parse.ts";

describe("ask.ts validates routing", () => {
	const base = { kind: "product", title: "T", context: "C", thread: "th", server: "main", threadId: "thread-1" };
	test("keeps a thread route with its relay text, and drops relay text from a steward option", () => {
		const i = parseAsk(
			{
				...base,
				options: [
					{ label: "Go", route: "thread", relay: "  Do it.  " },
					{ label: "Hold", route: "steward", relay: "ignored" },
					"Later",
				],
			},
			"Q-abcd1",
		);
		expect(i.options).toEqual([
			{ label: "Go", route: "thread", relay: "Do it." },
			{ label: "Hold" },
			{ label: "Later" },
		]);
	});
	test("rejects a thread route with no relay text, one with no threadId, and an unknown route", () => {
		expect(() => parseAsk({ ...base, options: [{ label: "Go", route: "thread" }, "Hold"] }, "Q-x")).toThrow(/relay/);
		expect(() =>
			parseAsk({ ...base, options: [{ label: "Go", route: "thread", relay: "   " }, "Hold"] }, "Q-x"),
		).toThrow(/relay/);
		expect(() =>
			parseAsk(
				{ ...base, threadId: undefined, options: [{ label: "Go", route: "thread", relay: "Do it." }, "Hold"] },
				"Q-x",
			),
		).toThrow(/threadId/);
		expect(() => parseAsk({ ...base, options: [{ label: "Go", route: "elsewhere" }, "Hold"] }, "Q-x")).toThrow(/route/);
		expect(() => parseAsk({ ...base, options: [{ label: "Go", route: "thread", relay: 5 }, "Hold"] }, "Q-x")).toThrow(
			/relay/,
		);
	});
	test("an item with no routes parses as it always has", () => {
		const i = parseAsk({ ...base, threadId: undefined, options: ["A", "B"] }, "Q-abcd1");
		expect(i.options).toEqual([{ label: "A" }, { label: "B" }]);
	});
});

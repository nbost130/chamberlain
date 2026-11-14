import { describe, expect, test } from "bun:test";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import type { Adapter } from "./adapter.ts";
import { conformance } from "./adapter-conformance.ts";

describe("conformance: every problem, in a fixed order", () => {
	test("a missing id, then required methods, then wake, then each optional capability, then unknown ones", () => {
		const base = createFakeAdapter({ capabilities: [] });
		const broken = {
			...base,
			id: "",
			watch: undefined,
			isBusy: undefined,
			post: undefined,
			wake: { ready: () => true },
			capabilities: ["answer", "telepathy", "send"],
			setTitle: async () => "set",
			send: async () => ({ ok: true, detail: "x" }),
			inspect: async () => undefined,
		} as unknown as Adapter;
		expect(conformance(broken)).toEqual([
			"no id",
			"required method watch is missing",
			"required method isBusy is missing",
			"required method post is missing",
			"required capability wake needs ready() and send()",
			"declares answer but does not implement it",
			"implements setTitle but does not declare it",
			"implements inspect but does not declare it",
			"declares unknown capability telepathy",
		]);
	});
});

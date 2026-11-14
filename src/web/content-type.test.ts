/**
 * The POST guard accepts the JSON media type and nothing that merely starts with it. A cross-site form cannot send
 * `application/json`, so the guard is only as strict as the match: a prefix match let `application/jsonxxx` through.
 */
import { describe, expect, test } from "bun:test";
import { askQuestion, readClaim } from "../core/questions.ts";
import { openCapability } from "../testing/capability.ts";
import { memStore } from "../testing/store.ts";
import { createApp, isJsonContentType } from "./app.ts";

const HOST = "127.0.0.1:3790";

describe("isJsonContentType", () => {
	test.each([
		["application/json", true],
		["application/json; charset=utf-8", true],
		["application/json;charset=utf-8", true],
		["  application/json ; charset=utf-8", true],
		["Application/JSON", true],
		["application/jsonxxx", false],
		["application/json-seq", false],
		["application/jsonp", false],
		["application/json+ld", false],
		["application/x-json", false],
		["text/plain", false],
		["text/json", false],
		["", false],
		[null, false],
		[undefined, false],
	] as const)("%p -> %p", (value, expected) => {
		expect(isJsonContentType(value)).toBe(expected);
	});
});

describe("the answer route", () => {
	const answerWith = async (contentType: string) => {
		const store = memStore();
		askQuestion(store, {
			id: "Q-abcd",
			kind: "product",
			title: "Q",
			context: "x",
			options: [{ label: "A" }],
			thread: "t",
			server: "main",
			createdAt: "2026-11-12T10:00:00.000Z",
		});
		const app = createApp({
			capability: openCapability(),
			store,
			state: "/nonexistent",
			log: () => {},
			hosts: [HOST],
			staticDir: "/nonexistent",
		});
		const r = await app.fetch(
			new Request(`http://${HOST}/api/items/Q-abcd/answer`, {
				method: "POST",
				headers: { host: HOST, "content-type": contentType, "x-decision-queue": "1" },
				body: JSON.stringify({ choice: 0 }),
			}),
		);
		await app.idle();
		return { status: r.status, claimed: readClaim(store, "Q-abcd") !== undefined };
	};
	test("application/jsonxxx is refused and nothing is claimed", async () => {
		expect(await answerWith("application/jsonxxx")).toEqual({ status: 403, claimed: false });
	});
	test("application/json and application/json; charset=utf-8 are accepted", async () => {
		expect(await answerWith("application/json")).toEqual({ status: 200, claimed: true });
		expect(await answerWith("application/json; charset=utf-8")).toEqual({ status: 200, claimed: true });
	});
});

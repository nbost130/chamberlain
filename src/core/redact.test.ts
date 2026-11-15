import { describe, expect, test } from "bun:test";
import { redactUrlFields, redactUrls } from "./redact.ts";

describe("redactUrls", () => {
	test("replaces a scheme:// run with <url>", () => {
		expect(redactUrls("failed https://hooks.example.test/abc XYZ")).toBe("failed <url> XYZ");
	});
	test("replaces a percent-encoded URL run", () => {
		expect(redactUrls("got https%3A%2F%2Fhooks.example.test%2Fsecret")).toBe("got <url>");
	});
	test("leaves text with no URL alone", () => {
		expect(redactUrls("connection refused")).toBe("connection refused");
	});
});

describe("redactUrlFields", () => {
	test("redacts string fields and leaves others alone", () => {
		expect(
			redactUrlFields({
				error: "at https://hooks.example.test/x",
				attempt: 1,
				ok: false,
			}),
		).toEqual({ error: "at <url>", attempt: 1, ok: false });
	});
});

import { describe, expect, test } from "bun:test";
import { MARK } from "../../testing/secrets.ts";
import { BAD, check, corrOf, ERR_CLASSES, errClass, T } from "./fields.ts";

const none = new Map<string, Set<string>>();

describe("opaque field types", () => {
	const ok: [keyof typeof T, unknown][] = [
		["uuid", "0b6c1a52-5a1e-4c0f-9d31-7a2f2b3c4d5e"],
		["hex12", "0123456789ab"],
		["item", "Q-ab12cd34"],
		["model", "claude-opus-5-5"],
		["model", "gpt-6.1-sol"],
		["model", "haiku"],
		["int", -3],
		["ms", 250],
		["bool", false],
	];
	const bad: [keyof typeof T, unknown][] = [
		["uuid", "thread-1"],
		["uuid", "Fix the login bug"],
		["hex12", "0123456789abc"],
		["hex12", "0123456789AB"],
		["item", "Q-"],
		["item", "Q-a b"],
		["model", "/home/nbost/models"],
		["model", "https://example.com/m"],
		["model", "a b"],
		["model", "0123456789abcdef0123456789abcdef"],
		["model", ["sk", "ant", "api03", `${MARK}abcdefghijklmnop`].join("-")],
		["model", `gh${"p"}_0123456789abcdefABCDEFghij`],
		["int", 1.5],
		["int", "7"],
		["ms", -1],
		["bool", "true"],
	];
	for (const [type, v] of ok)
		test(`${type} accepts ${JSON.stringify(v)}`, () => expect(check(T[type] as never, v, none)).toBe(v as never));
	for (const [type, v] of bad)
		test(`${type} refuses ${JSON.stringify(v)}`, () => expect(check(T[type] as never, v, none)).toBe(BAD));

	test("an enum takes only its members, a known set only what was allowed", () => {
		const e = T.enm("a", "b");
		expect(check(e, "a", none)).toBe("a");
		expect(check(e, "c", none)).toBe(BAD);
		const known = new Map([["server", new Set(["mac"])]]);
		expect(check(T.known("server"), "mac", known)).toBe("mac");
		expect(check(T.known("server"), "Fix the login bug", known)).toBe(BAD);
		expect(check(T.known("server"), "mac", none)).toBe(BAD);
	});

	test("a list is bounded and every member must pass", () => {
		const l = T.list(T.hex12, 2);
		expect(check(l, ["0123456789ab"], none)).toEqual(["0123456789ab"]);
		expect(check(l, ["0123456789ab", "0123456789ab", "0123456789ab"], none)).toBe(BAD);
		expect(check(l, ["0123456789ab", "a title"], none)).toBe(BAD);
		expect(check(l, "0123456789ab", none)).toBe(BAD);
	});

	test("there is no string type: no constructor accepts an arbitrary sentence", () => {
		const sentence = "the migration failed for /home/nbost/secret-project at https://hooks.example.com/x";
		const all = [T.uuid, T.hex12, T.item, T.model, T.int, T.ms, T.bool, T.enm("a"), T.known("s"), T.list(T.hex12)];
		for (const type of all) expect(check(type, sentence, none)).toBe(BAD);
	});
});

describe("errClass", () => {
	const cases: [unknown, string][] = [
		[Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
		["Error: connect ECONNREFUSED 10.0.0.1:3773", "ECONNREFUSED"],
		["read ECONNRESET", "ECONNRESET"],
		["the request timed out after 5000ms", "timeout"],
		[new Error("getaddrinfo ENOTFOUND hooks.example.com"), "ENOTFOUND"],
		["EACCES: permission denied, open '/etc/shadow'", "EACCES"],
		["ENOENT: no such file or directory, open '/home/me/x'", "ENOENT"],
		[new DOMException("aborted", "AbortError"), "abort"],
		["HTTP 404 Not Found", "http-4xx"],
		["status 503", "http-5xx"],
		["SQLITE_BUSY: database is locked", "busy"],
		[new SyntaxError("Unexpected token < in JSON"), "parse"],
		[new TypeError("x is not a function"), "type"],
		["something nobody planned for", "other"],
		[undefined, "other"],
		[{ weird: true }, "other"],
	];
	for (const [e, want] of cases)
		test(`${String(e).slice(0, 50)} is ${want}`, () => expect(errClass(e)).toBe(want as never));

	test("the result is always a listed class, and never carries the message", () => {
		for (const [e] of cases) expect(ERR_CLASSES).toContain(errClass(e));
		expect(errClass(new Error("token sk-abcdefghijklmnop leaked at https://x.example/y"))).toBe("other");
	});
});

describe("corrOf", () => {
	test("12 hex, stable, and different for different ids", () => {
		expect(corrOf("a")).toMatch(/^[0-9a-f]{12}$/);
		expect(corrOf("a")).toBe(corrOf("a"));
		expect(corrOf("a")).not.toBe(corrOf("b"));
		expect(corrOf("x".repeat(300))).toMatch(/^[0-9a-f]{12}$/);
	});
});

import { describe, expect, test } from "bun:test";
import { parseArgs } from "./ruling.ts";

describe("ruling.ts arguments", () => {
	test("the two texts, with no flags", () => {
		expect(parseArgs(["their words", "what it decides"])).toEqual({
			chat: false,
			opts: {},
			words: "their words",
			decides: "what it decides",
		});
	});
	test("--stated-in-chat, --expires, --until and --supersedes before the words", () => {
		const a = parseArgs([
			"--stated-in-chat",
			"--expires",
			"2026-12-01",
			"--until",
			"the V2 launch",
			"--supersedes",
			"R32,R16",
			"w",
			"d",
		]);
		expect(a).toEqual({
			chat: true,
			opts: { expires: "2026-12-01", until: "the V2 launch", supersedes: ["R32", "R16"] },
			words: "w",
			decides: "d",
		});
	});
	test("a flag without its value is an error", () => {
		expect(() => parseArgs(["--expires"])).toThrow("--expires needs a value");
		expect(() => parseArgs(["w", "d", "--supersedes"])).toThrow("--supersedes needs a value");
	});
	test("a mistyped flag is an error, but words that start with -- and have spaces, or come after --, are words", () => {
		expect(() => parseArgs(["--expire", "2026-12-01", "w", "d"])).toThrow(
			'unknown flag --expire (put their words after "--"',
		);
		expect(parseArgs(["--never do that", "d"]).words).toBe("--never do that");
		expect(parseArgs(["--", "--expire", "d"])).toMatchObject({ words: "--expire", decides: "d" });
		expect(parseArgs(["--expires", "2026-12-01", "--", "--stated-in-chat", "d"])).toMatchObject({
			chat: false,
			opts: { expires: "2026-12-01" },
			words: "--stated-in-chat",
			decides: "d",
		});
	});
	test("a missing text comes back undefined, for the usage message", () => {
		expect(parseArgs(["only words"])).toMatchObject({ words: "only words", decides: undefined });
	});
});

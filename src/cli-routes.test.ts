import { describe, expect, test } from "bun:test";
import { debugUsage, run, usage, VERSION } from "./cli.ts";

describe("the dispatcher answers version and help in place", () => {
	test("every spelling: -v, version, -h, --help, and debug -h, debug --help", async () => {
		const lines: string[] = [];
		const log = console.log;
		console.log = (...a: unknown[]) => {
			lines.push(a.join(" "));
		};
		try {
			for (const argv of [["-v"], ["version"]]) {
				expect(await run(argv)).toBe(0);
				expect(lines.pop()).toBe(VERSION);
			}
			for (const argv of [["-h"], ["--help"]]) {
				expect(await run(argv)).toBe(0);
				expect(lines.pop()).toBe(usage());
			}
			for (const argv of [
				["debug", "-h"],
				["debug", "--help"],
			]) {
				expect(await run(argv)).toBe(0);
				expect(lines.pop()).toBe(debugUsage());
			}
			expect(lines).toEqual([]);
		} finally {
			console.log = log;
		}
	});
});

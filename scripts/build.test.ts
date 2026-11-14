/** The release tooling: the formula renders only from a complete SHA256SUMS, and its service block runs the daemon. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TARGETS, tarballName } from "./build.ts";
import { parseSums, render } from "./render-formula.ts";

const template = readFileSync(new URL("../packaging/homebrew/chamberlain.rb.tmpl", import.meta.url), "utf8");
const digest = (n: number) => String(n).repeat(64).slice(0, 64);
const sums = Object.fromEntries(Object.keys(TARGETS).map((t, i) => [tarballName("1.2.3", t), digest(i + 1)]));

describe("scripts/render-formula.ts", () => {
	test("every platform gets its own release URL and checksum, and nothing is left unfilled", () => {
		const f = render(template, "1.2.3", sums, "o/chamberlain");
		// No `version` line: brew reads it from the URL, and `brew audit --strict` refuses a redundant one.
		expect(f).not.toMatch(/^\s*version\s/m);
		expect(f).toContain('homepage "https://github.com/o/chamberlain"');
		for (const [i, t] of Object.keys(TARGETS).entries()) {
			expect(f).toContain(`url "https://github.com/o/chamberlain/releases/download/v1.2.3/chamberlain-1.2.3-${t}.tar.gz"`);
			expect(f).toContain(`sha256 "${digest(i + 1)}"`);
		}
		expect(f).not.toMatch(/\{\{/);
	});
	test("a platform missing from SHA256SUMS refuses to render, so no formula goes out with a blank checksum", () => {
		const { [tarballName("1.2.3", "darwin-x64")]: _gone, ...partial } = sums;
		expect(() => render(template, "1.2.3", partial, "o/chamberlain")).toThrow("chamberlain-1.2.3-darwin-x64.tar.gz");
	});
	test("a checksum for another version is not used", () => {
		expect(() => render(template, "1.2.4", sums, "o/chamberlain")).toThrow("SHA256SUMS has no entry");
	});
	test("sha256sum output parses, in both text and binary mode, and a bad line is refused", () => {
		expect(parseSums(`${digest(1)}  a.tar.gz\n${digest(2)} *b.tar.gz\n`)).toEqual({ "a.tar.gz": digest(1), "b.tar.gz": digest(2) });
		expect(() => parseSums("nonsense")).toThrow("cannot read");
	});
	test("`brew services start chamberlain` runs the daemon, kept alive, and bin/chamberlain is not stripped", () => {
		expect(template).toContain('run [opt_bin/"chamberlain", "daemon"]');
		expect(template).toContain("keep_alive true");
		expect(template).toContain('skip_clean "bin/chamberlain"');
	});
});

describe("scripts/build.ts", () => {
	test("the four release platforms, as Bun's compile targets", () => {
		expect(TARGETS).toEqual({ "linux-x64": "bun-linux-x64", "linux-arm64": "bun-linux-arm64", "darwin-arm64": "bun-darwin-arm64", "darwin-x64": "bun-darwin-x64" });
		expect(tarballName("0.2.0", "linux-x64")).toBe("chamberlain-0.2.0-linux-x64.tar.gz");
	});
});

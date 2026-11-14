/**
 * The delivery guarantee is documented where it should be. The behaviour itself is tested where it happens (relay.test.ts, crash.test.ts);
 * this only checks that each section a reader is sent to exists, so the docs and the code do not drift apart by a section being renamed or
 * dropped. It pins no wording.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const headings = (p: string) => read(p).split("\n").filter((l) => /^#{1,4} /.test(l)).map((l) => l.replace(/^#+ /, "").trim());

const sources = (dir: string): string[] =>
	readdirSync(join(ROOT, dir)).flatMap((n) => {
		const p = join(dir, n);
		return statSync(join(ROOT, p)).isDirectory() ? (n === "node_modules" ? [] : sources(p)) : n.endsWith(".ts") ? [p] : [];
	});

describe("each documented section exists", () => {
	test("the architecture document has its delivery-guarantee and state sections", () => {
		const h = headings("docs/ARCHITECTURE.md");
		expect(h).toContain("Delivery guarantees and the windows that remain");
		expect(h).toContain("Where state lives");
	});

	test("the delivery-guarantee section keeps its numbered points, including the one relay", () => {
		const arch = read("docs/ARCHITECTURE.md");
		const section = arch.slice(arch.indexOf("## Delivery guarantees and the windows that remain"), arch.indexOf("## Where state lives"));
		expect(section).toContain("**One relay.**");
		expect(section).toContain("**A row is immutable");
	});

	test("the delivery document and the glossary exist for the README to link to", () => {
		expect(read("docs/DELIVERY.md").length).toBeGreaterThan(0);
		const g = headings("docs/GLOSSARY.md").length + read("docs/GLOSSARY.md").split("\n").filter((l) => l.startsWith("| ")).length;
		expect(g).toBeGreaterThan(0);
	});
});

describe("the one-relay lock does not leak into a child (close-on-exec covers an exec, not a fork without one)", () => {
	test("no production module forks without exec: the only foreign code called through bun:ffi is flock and errno", () => {
		const prod = sources("src").filter((f) => !f.endsWith(".test.ts"));
		const ffi = prod.filter((f) => /\bdlopen\s*\(/.test(read(f)));
		expect(ffi.map((f) => relative(ROOT, join(ROOT, f)))).toEqual(["src/core/singleton.ts"]);
		const code = read("src/core/singleton.ts");
		expect([...code.matchAll(/\b(flock|errno|__errno_location|__error|fork|vfork|clone|posix_spawn)\s*:\s*\{\s*args/g)].map((m) => m[1]).sort()).toEqual(["flock"]);
		for (const f of prod) expect(read(f), f).not.toMatch(/node:cluster|\bos\.fork\b|\bsyscall\s*\(/);
	});
});

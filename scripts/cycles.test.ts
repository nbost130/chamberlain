import { describe, expect, test } from "bun:test";
import { cyclesOf, valueImports } from "./cycles.ts";

const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges));

describe("the import-cycle check", () => {
	test("finds a two-file cycle, a three-file cycle and a file that imports itself, and nothing in an acyclic graph", () => {
		expect(cyclesOf(graph({ a: ["b"], b: ["c"], c: [] }))).toEqual([]);
		expect(cyclesOf(graph({ a: ["b"], b: ["a"] }))).toEqual([["a", "b"]]);
		expect(cyclesOf(graph({ a: ["b"], b: ["c"], c: ["a"], d: ["a"] }))).toEqual([["a", "b", "c"]]);
		expect(cyclesOf(graph({ a: ["a"] }))).toEqual([["a"]]);
	});

	test("a cycle off to the side is found beside an acyclic part", () => {
		const found = cyclesOf(graph({ root: ["x", "y"], x: [], y: ["z"], z: ["y"] }));
		expect(found).toEqual([["y", "z"]]);
	});

	test("type-only imports are erased, so they make no edge; value imports and re-exports do", () => {
		const code = [
			'import type { A } from "./a.ts";',
			'import { type B, type C } from "./b.ts";',
			'import { d, type E } from "./d.ts";',
			'import F from "./f.ts";',
			'export { g } from "./g.ts";',
			'export type { H } from "./h.ts";',
			'import { node } from "node:path";',
		].join("\n");
		expect(valueImports("/r/x.ts", code).map((p) => p.replace("/r/", ""))).toEqual(["d.ts", "f.ts", "g.ts"]);
	});

	test("the repository has no import cycle", async () => {
		const proc = Bun.spawn(["bun", `${import.meta.dir}/cycles.ts`], { stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
	});
});

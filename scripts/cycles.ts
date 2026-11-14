#!/usr/bin/env bun
// Fails when the value-import graph of src/ and scripts/ has a cycle. A cycle is a load-order hazard: a module that reads another
// module's top-level value while the two are still loading fails with a ReferenceError, and only when it is the first one imported.
// Type-only imports are erased and make no edge, so they are not counted. Test files are not part of the graph.
//
//   bun scripts/cycles.ts            check the repo; exit 1 and print each cycle when there is one
//
// No cycle is allowed: a shared piece goes into a leaf module that both sides import.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIRS = ["src", "scripts"];

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
	});
}

/** The names an import clause binds are all `type X`: erased at run time, so no edge. */
function typeOnly(clause: string): boolean {
	if (/^type\s/.test(clause)) return true;
	const named = /\{([^}]*)\}/.exec(clause)?.[1];
	if (named === undefined || /^[\w$]+\s*,/.test(clause) || /^[\w$]+\s*$/.test(clause)) return false;
	const names = named
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	return names.length > 0 && names.every((n) => n.startsWith("type "));
}

/** The files `file` imports at run time. */
export function valueImports(file: string, code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(/^(?:import|export)\s+([^;"']*?)\s*from\s*["'](\.[^"']+)["']/gm)) {
		if (typeOnly(m[1] ?? "")) continue;
		out.push(resolve(dirname(file), m[2] ?? ""));
	}
	return out;
}

/** Tarjan's algorithm over the files: the strongly connected components with more than one file, or a file that imports itself. */
class Components {
	private next = 0;
	private readonly index = new Map<string, number>();
	private readonly low = new Map<string, number>();
	private readonly stack: string[] = [];
	private readonly onStack = new Set<string>();
	readonly found: string[][] = [];

	constructor(private readonly graph: Map<string, string[]>) {
		for (const v of graph.keys()) if (!this.index.has(v)) this.visit(v);
	}

	private visit(v: string) {
		this.index.set(v, this.next);
		this.low.set(v, this.next++);
		this.stack.push(v);
		this.onStack.add(v);
		for (const w of this.graph.get(v) ?? []) this.follow(v, w);
		if (this.low.get(v) === this.index.get(v)) this.close(v);
	}

	/** The edge v -> w: walk on to w if it is new, and let v's low-link see w if w is still open. */
	private follow(v: string, w: string) {
		if (!this.graph.has(w)) return;
		if (!this.index.has(w)) {
			this.visit(w);
			this.lower(v, this.low.get(w));
		} else if (this.onStack.has(w)) this.lower(v, this.index.get(w));
	}

	private lower(v: string, to: number | undefined) {
		this.low.set(v, Math.min(this.low.get(v) ?? 0, to ?? 0));
	}

	/** v is the root of a component: pop it off the stack. */
	private close(v: string) {
		const comp: string[] = [];
		for (let w = this.stack.pop(); w !== undefined; w = this.stack.pop()) {
			this.onStack.delete(w);
			comp.push(w);
			if (w === v) break;
		}
		if (comp.length > 1 || (this.graph.get(v) ?? []).includes(v)) this.found.push(comp.sort());
	}
}

export const cyclesOf = (graph: Map<string, string[]>): string[][] => new Components(graph).found;

function main(): number {
	const files = DIRS.flatMap((d) => sources(join(ROOT, d)));
	const graph = new Map(files.map((f) => [f, valueImports(f, readFileSync(f, "utf8"))]));
	const bad = cyclesOf(graph);
	for (const c of bad) console.error(`import cycle: ${c.map((f) => relative(ROOT, f)).join(" <-> ")}`);
	console.log(bad.length ? `${bad.length} import cycle(s)` : `no import cycles in ${files.length} files`);
	return bad.length ? 1 : 0;
}

if (import.meta.main) process.exit(main());

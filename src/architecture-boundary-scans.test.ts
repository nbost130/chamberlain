/** The architecture scanners shared by the architecture.*.test.ts files. A .test.ts, not a file under src/testing/: other scans read every non-test source file for the very patterns these define. No tests here; the architecture.*.test.ts files run them. */

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const SRC = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** Pure: the module specifiers of every static import, re-export (type-only ones too) and dynamic import in a source text. */
export function specifiers(code: string): string[] {
	const bare = stripComments(code);
	const out: string[] = [];
	// A static import or re-export, a side-effect import, and a call to import or require with a literal first argument (extra arguments, such as
	// import attributes, and a space before the parenthesis included).
	for (const m of bare.matchAll(
		/\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*[,)]/g,
	))
		out.push((m[1] ?? m[2] ?? m[3])!);
	return out;
}

/** Every .ts file under `dir` of `root`, recursively, as paths relative to `root`. The inventory the scans below run on: nothing is listed by hand. */
export function walk(root: string, dir = ""): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(root, join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
	);
}
/** Every .ts file under a directory of src/, as paths relative to src/. */
export const files = (dir: string) => walk(SRC, dir);

/**
 * The imports of a source text (static, dynamic, require and re-exports) that point into this tree, as src/-relative paths: relative
 * specifiers resolved against `from`, and absolute paths and file: URLs as they are. A package name points nowhere in src/ and is not listed.
 */
export function importsOf(code: string, from: string): string[] {
	return specifiers(code).flatMap((p) => {
		if (p.startsWith(".")) return [relative(SRC, resolve(SRC, dirname(from), p))];
		const abs = p.replace(/^file:\/\//, "");
		return abs.startsWith("/") ? [relative(SRC, abs)] : [];
	});
}

/** Pure: the violations of the rules in one file: what it imports that it may not. */
export function violations(file: string, code: string): string[] {
	const bad: string[] = [];
	for (const target of importsOf(code, file)) {
		if (file.startsWith("core/") && target.startsWith("adapters"))
			bad.push(`${file} imports ${target}: core must not import from src/adapters/`);
		const mine = file.match(/^adapters\/([^/]+)\//)?.[1];
		const theirs = target.match(/^adapters\/([^/.]+)(?:\/|\.|$)/)?.[1];
		if (mine && theirs && theirs !== "index" && mine !== theirs)
			bad.push(`${file} imports ${target}: an adapter must not import another adapter`);
		if (mine && target === "adapters/index.ts")
			bad.push(`${file} imports the registry: an adapter is made by it, never the reverse`);
		if (
			file.startsWith("web/") &&
			!file.endsWith(".test.ts") &&
			file !== "web/server.ts" &&
			target.startsWith("adapters")
		)
			bad.push(`${file} imports ${target}: the page works through the adapter contract`);
	}
	return bad;
}

/**
 * The fourth rule: an optional module (src/modules/<name>/, contract in src/core/module.ts) is OFF unless its config section turns it on,
 * and Chamberlain runs the same without it. The structure that keeps it out when it is off:
 *   - nothing outside src/modules/ imports a module's own files: the only way in is the registry, src/modules/index.ts, and only the entry
 *     points (src/cli.ts, src/daemon.ts) may import that. A test outside core/ may too, to drive it. Core, an adapter or the page never does.
 *   - a module imports src/core/ and its own folder: never an adapter, never another module, and never the registry that makes it.
 *   - a module opens its database through the shared opener (src/core/database.ts), never by naming bun:sqlite itself, so its file is private,
 *     migrated and refused-when-newer exactly as `chamberlain.db` is.
 */
export const REGISTRY = "modules/index.ts";
const MAY_IMPORT_REGISTRY = new Set(["cli.ts", "daemon.ts"]);

/** Pure: the violations of the module rules in one file: what it imports that it may not. `file` is src/-relative. */
export function moduleViolations(file: string, code: string): string[] {
	const bad: string[] = [];
	const mine = file.match(/^modules\/([^/]+)\//)?.[1];
	for (const target of importsOf(code, file)) {
		const theirs = target.match(/^modules\/([^/.]+)\//)?.[1];
		if (file.startsWith("core/") && target.startsWith("modules"))
			bad.push(`${file} imports ${target}: core must not import from src/modules/`);
		else if (!file.startsWith("modules/") && target.startsWith("modules") && target !== REGISTRY)
			bad.push(`${file} imports ${target}: a module is reached only through the registry (${REGISTRY})`);
		else if (target === REGISTRY && !file.startsWith("modules/")) {
			const test = file.endsWith(".test.ts") && !file.startsWith("core/");
			if (!MAY_IMPORT_REGISTRY.has(file) && !test)
				bad.push(`${file} imports the registry: only src/cli.ts and src/daemon.ts may`);
		}
		if (mine && target.startsWith("adapters"))
			bad.push(`${file} imports ${target}: a module must not import an adapter`);
		if (mine && theirs && theirs !== mine)
			bad.push(`${file} imports ${target}: a module must not import another module`);
		if (mine && target === REGISTRY)
			bad.push(`${file} imports the registry: a module is made by it, never the reverse`);
	}
	if (mine && !file.endsWith(".test.ts") && specifiers(code).includes("bun:sqlite"))
		bad.push(`${file} imports bun:sqlite: a module opens its database through src/core/database.ts`);
	return bad;
}

/**
 * The module's reach (docs/EMAIL-TRIAGE.md, section 8, "Tracking links are never opened by the module"): a module has no HTTP client and
 * starts no process of its own. A non-test file under src/modules/ may not call `fetch(`, open a socket or server, name an HTTP, socket or
 * DNS package, or start a process; the model CLI is spawned by src/core/llm/cli.ts, which is core. A provider or a route that must run the
 * operator's own program is listed in MAY_SPAWN with the reason, and nothing else is: B2 (#35) lists the provider's file, B7 (#40) the route's.
 *
 * What the scan enforces, in source text (it reads names, so a name built at run time is outside it; the behavioural proof is the real daemon
 * test in src/modules/daemon.test.ts, which counts every child the kernel saw):
 *   - the process APIs: `node:child_process` and `node:cluster`; the package `bun` itself, whose named exports `$`, `spawn` and `spawnSync`
 *     (and `serve`, `connect`) are the same capabilities as the global's; `bun:ffi`; and the process libraries execa, cross-spawn, zx,
 *     shelljs and node-pty;
 *   - the `Bun` global: a module may name only the members in SAFE_BUN. `Bun.$`, `Bun.spawn`, a destructured or aliased `Bun`, `Bun?.x`,
 *     `globalThis.Bun` and `Bun["x"]` are all a reference to `Bun` that is not one of those members, so each is refused;
 *   - the network: `fetch(`, WebSocket, XMLHttpRequest and the HTTP, socket and DNS packages.
 */
export const MAY_SPAWN: Record<string, string> = {};
/** The members of the `Bun` global a module may use: files, time and hashing, none of which starts a process or opens a socket. */
const SAFE_BUN = "file|write|sleep|sleepSync|hash|nanoseconds|env";
const NETWORK_PACKAGES =
	/^(node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises)$|^(undici|ws|node-fetch|axios|got)$/;
const SPAWN_PACKAGES = /^(node:)?(child_process|cluster)$|^(bun|bun:ffi|execa|cross-spawn|zx|shelljs|node-pty)$/;
const NETWORK_CALLS = /\bfetch\s*\(|\bnew\s+WebSocket\b|\bXMLHttpRequest\b/;
const BUN_GLOBAL_OUTSIDE_SAFE = new RegExp(`\\bBun\\b(?!\\s*\\.\\s*(?:${SAFE_BUN})\\b)`);
const SPAWN_CALLS = /\b(execa|spawnSync|execSync|execFile|execFileSync)\s*\(/;

/** Pure: the violations of the reach rule in one non-test file under src/modules/. `file` is src/-relative. */
export function moduleReachViolations(file: string, code: string): string[] {
	if (!file.startsWith("modules/") || file.endsWith(".test.ts")) return [];
	const bare = stripComments(code);
	const bad: string[] = [];
	for (const spec of specifiers(code)) {
		if (NETWORK_PACKAGES.test(spec)) bad.push(`${file} imports ${spec}: a module has no HTTP, socket or DNS client`);
		if (SPAWN_PACKAGES.test(spec) && !(file in MAY_SPAWN))
			bad.push(`${file} imports ${spec}: a module starts no process unless MAY_SPAWN lists the file`);
	}
	if (NETWORK_CALLS.test(bare))
		bad.push(`${file} calls fetch or opens a socket or server: a module has no network client`);
	if (BUN_GLOBAL_OUTSIDE_SAFE.test(bare))
		bad.push(
			`${file} names Bun outside Bun.{${SAFE_BUN.replaceAll("|", ",")}}: that is where a process, socket or server starts`,
		);
	if (SPAWN_CALLS.test(bare) && !(file in MAY_SPAWN))
		bad.push(`${file} starts a process: a module starts none unless MAY_SPAWN lists the file`);
	return bad;
}

/**
 * The source with comments removed. A `//` is a comment unless it follows a `:`, a quote or a `/` (the `//` of `https://` or `file:///` inside a
 * string is not one: stripping it would cut the rest of the line, and an import after it would not be seen).
 */
export function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\/])\/\/.*$/gm, "$1");
}

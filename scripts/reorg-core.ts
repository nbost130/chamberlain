/**
 * One-shot (already applied on branch refactor/core-subfolders): move src/core/*.ts into concern folders
 * and rewrite relative imports + `src/core/<file>` strings. Refuses to run if the folders already exist.
 * Run from repo root: bun scripts/reorg-core.ts
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const CORE = join(ROOT, "src/core");
const ALREADY = [
	"steward",
	"delivery",
	"engine",
	"desk",
	"items",
	"ops",
	"store",
	"decide",
	"config",
	"adapter",
	"sweep",
];
if (
	ALREADY.some((f) => {
		try {
			return readdirSync(join(CORE, f)).some((n) => n.endsWith(".ts"));
		} catch {
			return false;
		}
	})
) {
	console.error("reorg already applied (core concern folders have .ts files); refusing to run again");
	process.exit(1);
}

/** First matching rule wins. More specific prefixes before broader ones. */
const RULES: { folder: string; re: RegExp }[] = [
	{ folder: "steward", re: /^(steward-|brief|handoff|rights-sent)/ },
	{ folder: "desk", re: /^(alert-desk|alert-triage)/ },
	{ folder: "items", re: /^(alert|source|notification|card|questions|snooze|settled|item)/ },
	{ folder: "delivery", re: /^(deliver|relay|singleton|wake-id|wakes-cli)/ },
	{ folder: "store", re: /^(store|sqlite-|migrations|schema|database|default-store|apply-migrations)/ },
	{ folder: "engine", re: /^engine/ },
	{ folder: "decide", re: /^(decide|hold|idle|undelivered|wait-phrases)/ },
	{ folder: "config", re: /^(config|layout|servers|settings-parse|migrate)/ },
	{ folder: "ops", re: /^(afk|ruling|butler|recover|judge|capability|maintain|retention|history|rules|decided)/ },
	{ folder: "sweep", re: /^sweep/ },
	{ folder: "adapter", re: /^adapter/ },
];

function assign(name: string): string | null {
	for (const r of RULES) if (r.re.test(name)) return r.folder;
	return null;
}

function exists(repoRel: string): boolean {
	try {
		return statSync(join(ROOT, repoRel)).isFile();
	} catch {
		return false;
	}
}

/** old repo-relative path → new */
const moves = new Map<string, string>();
/** new → old */
const reverse = new Map<string, string>();

for (const name of readdirSync(CORE)) {
	const abs = join(CORE, name);
	if (!statSync(abs).isFile() || !name.endsWith(".ts")) continue;
	const folder = assign(name);
	if (!folder) continue;
	const from = `src/core/${name}`;
	const to = `src/core/${folder}/${name}`;
	moves.set(from, to);
	reverse.set(to, from);
}

if (moves.size === 0) {
	console.error("nothing to move");
	process.exit(1);
}

for (const folder of new Set([...moves.values()].map((p) => dirname(p)))) {
	mkdirSync(join(ROOT, folder), { recursive: true });
}

for (const [from, to] of moves) {
	await $`git mv ${from} ${to}`.cwd(ROOT);
	console.log(`mv ${from} → ${to}`);
}

function asTsPath(absOrRel: string): string {
	const abs = absOrRel.startsWith("/") ? absOrRel : join(ROOT, absOrRel);
	const withTs = abs.endsWith(".ts") ? abs : `${abs}.ts`;
	return relative(ROOT, withTs).replaceAll(sep, "/");
}

/** Where an import written at `writtenFrom` with specifier `spec` pointed, as repo-relative .ts (pre- or post-move). */
function resolveWritten(writtenFrom: string, spec: string): string | null {
	if (!spec.startsWith(".")) return null;
	const resolved = resolve(ROOT, dirname(writtenFrom), spec);
	const asTs = asTsPath(resolved);
	if (moves.has(asTs)) return asTs; // still the old key in the map
	const fromNew = reverse.get(asTs);
	if (fromNew) return fromNew; // already at new path
	if (exists(asTs)) return asTs;
	if (exists(moves.get(asTs) ?? "")) return asTs;
	return null;
}

function relSpec(fromFile: string, toFile: string): string {
	let r = relative(dirname(join(ROOT, fromFile)), join(ROOT, toFile)).replaceAll(sep, "/");
	if (!r.startsWith(".")) r = `./${r}`;
	return r;
}

const importRe = /\b((?:import|export)\b[^"';]*?\bfrom\s*|import\s*|import\s*\(\s*|require\s*\(\s*)(["'])(\.[^"']+)\2/g;

const textFiles: string[] = [];
const walk = (dir: string) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === ".git") continue;
			walk(p);
		} else if (/\.(ts|md|json)$/.test(e.name) && e.name !== "reorg-core.ts") {
			textFiles.push(relative(ROOT, p).replaceAll(sep, "/"));
		}
	}
};
for (const root of ["src", "scripts", "docs", "examples", ".claude"]) {
	try {
		walk(join(ROOT, root));
	} catch {
		/* missing */
	}
}
for (const f of ["README.md", "CONTRIBUTING.md", "CHANGELOG.md"]) {
	if (exists(f)) textFiles.push(f);
}

let importEdits = 0;
let pathEdits = 0;

for (const file of textFiles) {
	const abs = join(ROOT, file);
	let text = readFileSync(abs, "utf8");
	const orig = text;

	if (file.endsWith(".ts")) {
		// Imports were written when the file lived at `writtenFrom` (old path if moved).
		const writtenFrom = reverse.get(file) ?? file;
		text = text.replace(importRe, (full, prefix: string, quote: string, spec: string) => {
			const oldTarget = resolveWritten(writtenFrom, spec);
			if (!oldTarget) return full;
			const newTarget = moves.get(oldTarget) ?? oldTarget;
			const next = relSpec(file, newTarget);
			if (next === spec) return full;
			importEdits++;
			return `${prefix}${quote}${next}${quote}`;
		});
	}

	for (const [from, to] of moves) {
		if (!text.includes(from)) continue;
		const n = text.split(from).length - 1;
		text = text.split(from).join(to);
		pathEdits += n;
	}

	if (text !== orig) writeFileSync(abs, text);
}

console.log(`\nmoved ${moves.size} files`);
console.log(`import specifier edits: ${importEdits}`);
console.log(`src/core/... path string edits: ${pathEdits}`);
console.log("\nby folder:");
const counts = new Map<string, number>();
for (const to of moves.values()) {
	const folder = to.split("/")[2] ?? "";
	counts.set(folder, (counts.get(folder) ?? 0) + 1);
}
for (const [f, n] of [...counts.entries()].sort()) console.log(`  ${f}: ${n}`);
